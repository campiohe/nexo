// Nexo's minimal libretro frontend for Mupen64Plus-Next (GLideN64 on OpenGL ES 3 = WebGL 2), compiled together
// with the core into one WebAssembly module (see build.sh). It replaces RetroArch: the worker (../worker.ts)
// creates the WebGL 2 context on its OffscreenCanvas, makes it current, then calls the nexo_* exports once per
// emulated frame (one N64 vertical interrupt).
//
// Picture: GLideN64 renders into our framebuffer object (RETRO_ENVIRONMENT_SET_HW_RENDER's
// get_current_framebuffer) at the core's internal resolution; after each frame that produced a new picture we
// blit it into the canvas's own framebuffer at the canvas's fixed size (OUT_W × OUT_H), so the stream never
// changes size whatever the core does.
//
// Sound: stereo int16 at the core's rate (44100 Hz), read by the worker after each frame.
//
// No coroutines: upstream runs the emulator in a libco "thread" and switches back to the frontend at every VI.
// WebAssembly can't switch stacks (short of Asyncify, which would slow the CPU interpreter down a lot), so
// patches/0001-nexo-reentrant-wasm.patch makes the cached interpreter return at every VI instead
// (nexo_co_yield) and resume from the same PC on the next call. The co_* functions below are libco's API on
// top of that: co_switch(game) runs the emulation up to the next VI, co_switch(frontend) asks it to stop there.
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>

#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <emscripten/emscripten.h>

#include "api/m64p_types.h"
#include "libretro.h"

m64p_error CoreDoCommand(m64p_command command, int param, void *ptr); // mupen64plus-core/src/api/frontend.c

#define OUT_W 640
#define OUT_H 480
#define PORTS 4
// One NTSC VI is ~735 frames at 44100 Hz; the audio plugin may hand over a few VIs' worth at once.
#define AUDIO_CAP 16384

// ---- libco stand-in --------------------------------------------------------------------------------------------

typedef void *cothread_t;
#define CO_FRONTEND ((cothread_t)1)
#define CO_GAME ((cothread_t)2)

volatile int nexo_co_yield;
void nexo_resume_emulation(void); // mupen64plus-core/src/main/main.c (patched)

static void (*game_entry)(void);
static int game_started, game_running, game_finished;

cothread_t co_active(void) { return game_running ? CO_GAME : CO_FRONTEND; }

cothread_t co_create(unsigned int size, void (*entry)(void)) {
  (void)size;
  game_entry = entry;
  game_started = game_finished = 0;
  return CO_GAME;
}

void co_delete(cothread_t thread) { (void)thread; }

void co_switch(cothread_t thread) {
  if (thread != CO_GAME) {
    // From inside the emulation (new_vi → retro_return, or main_run's end): stop at the next instruction.
    nexo_co_yield = 1;
    return;
  }
  if (game_running || game_finished || !game_entry) return;
  game_running = 1;
  nexo_co_yield = 0;
  if (!game_started) {
    game_started = 1;
    // EmuThreadFunction: boots the console, returns at the first VI. It's really `void *(void *)` (libretro.c
    // casts it for co_create), and WebAssembly checks indirect calls' signatures: call it as what it is.
    ((void *(*)(void *))game_entry)(NULL);
  } else {
    nexo_resume_emulation();
  }
  if (!nexo_co_yield) game_finished = 1; // the emulation stopped (never happens while Nexo runs a game)
  game_running = 0;
}

int co_serializable(void) { return 0; }

// ---- state -----------------------------------------------------------------------------------------------------

static int16_t audio_buf[AUDIO_CAP * 2];
static unsigned audio_frames;
static unsigned n64_keys[PORTS];
static int frame_drawn;
static unsigned frame_w = OUT_W, frame_h = OUT_H;
static double av_fps = 60.0;
static double av_rate = 44100.0;
static const struct retro_core_option_v2_definition *option_defs;
static struct retro_hw_render_callback hw;
static int hw_ok;
static GLuint fbo, fbo_color, fbo_depth;
static unsigned fbo_w, fbo_h;

// Options Nexo pins; everything else uses the core's defaults (read from its option definitions).
static const char *const OVERRIDES[][2] = {
    {"mupen64plus-rdp-plugin", "gliden64"},
    {"mupen64plus-rsp-plugin", "hle"},
    {"mupen64plus-cpucore", "cached_interpreter"}, // the only one that can resume (see above); no dynarec in wasm
    {"mupen64plus-ThreadedRenderer", "False"},
    {"mupen64plus-43screensize", "640x480"},     // 2× the N64's 320×240, exactly the canvas
    {"mupen64plus-aspect", "4:3"},
    {"mupen64plus-EnableNativeResFactor", "0"},
    {"mupen64plus-MultiSampling", "0"},
    {"mupen64plus-FXAA", "0"},
    // WebGL can't map buffers for reading (Async/TripleBuffer) and a synchronous readPixels per frame stalls
    // the GPU; a few games lose effects that read the picture back (e.g. some pause screens).
    {"mupen64plus-EnableCopyColorToRDRAM", "Off"},
    {"mupen64plus-EnableShadersStorage", "False"}, // no disk
    {"mupen64plus-EnableTextureCache", "False"},
    {"mupen64plus-txHiresEnable", "False"},
    {"mupen64plus-EnableLegacyBlending", "False"},    // desktop GPUs do the accurate blending fine
    {"mupen64plus-EnableFragmentDepthWrite", "True"}, // WebGL 2 has gl_FragDepth
    {"mupen64plus-FrameDuping", "False"},
    {"mupen64plus-Framerate", "Original"},
    {"mupen64plus-pak1", "memory"}, // a Controller Pak per player (formatted, in memory for the session)
    {"mupen64plus-pak2", "memory"},
    {"mupen64plus-pak3", "memory"},
    {"mupen64plus-pak4", "memory"},
};

static const char *option_value(const char *key) {
  for (size_t i = 0; i < sizeof(OVERRIDES) / sizeof(OVERRIDES[0]); i++)
    if (!strcmp(OVERRIDES[i][0], key)) return OVERRIDES[i][1];
  for (const struct retro_core_option_v2_definition *d = option_defs; d && d->key; d++)
    if (!strcmp(d->key, key)) return d->default_value ? d->default_value : d->values[0].value;
  return NULL;
}

static void log_printf(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_WARN) return;
  char line[1024];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line, sizeof line, fmt, ap);
  va_end(ap);
  fprintf(stderr, "[mupen64plus] %s", line);
}

// ---- video -----------------------------------------------------------------------------------------------------

static uintptr_t get_current_framebuffer(void) { return fbo; }

static retro_proc_address_t get_proc_address(const char *sym) {
  return (retro_proc_address_t)eglGetProcAddress(sym);
}

/** (Re)creates the core's render target: RGBA8 colour + depth/stencil, at least w × h. */
static void ensure_fbo(unsigned w, unsigned h) {
  if (w < OUT_W) w = OUT_W;
  if (h < OUT_H) h = OUT_H;
  if (fbo && w <= fbo_w && h <= fbo_h) return;
  if (!fbo) {
    glGenFramebuffers(1, &fbo);
    glGenTextures(1, &fbo_color);
    glGenRenderbuffers(1, &fbo_depth);
  }
  fbo_w = w;
  fbo_h = h;
  glBindTexture(GL_TEXTURE_2D, fbo_color);
  glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
  glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
  glBindTexture(GL_TEXTURE_2D, 0);
  glBindRenderbuffer(GL_RENDERBUFFER, fbo_depth);
  glRenderbufferStorage(GL_RENDERBUFFER, GL_DEPTH24_STENCIL8, w, h);
  glBindRenderbuffer(GL_RENDERBUFFER, 0);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, fbo_color, 0);
  glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_DEPTH_STENCIL_ATTACHMENT, GL_RENDERBUFFER, fbo_depth);
  glClearColor(0, 0, 0, 1);
  glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
}

/** The new picture → the canvas (scaled to OUT_W × OUT_H). Runs between frames, while glsm has unbound its state. */
static void present(void) {
  unsigned w = frame_w < fbo_w ? frame_w : fbo_w;
  unsigned h = frame_h < fbo_h ? frame_h : fbo_h;
  GLboolean scissor = glIsEnabled(GL_SCISSOR_TEST);
  GLboolean mask[4];
  glGetBooleanv(GL_COLOR_WRITEMASK, mask);
  if (scissor) glDisable(GL_SCISSOR_TEST);
  glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE);
  glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
  glBindFramebuffer(GL_DRAW_FRAMEBUFFER, 0);
  glBlitFramebuffer(0, 0, w, h, 0, 0, OUT_W, OUT_H, GL_COLOR_BUFFER_BIT,
                    w == OUT_W && h == OUT_H ? GL_NEAREST : GL_LINEAR);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  glColorMask(mask[0], mask[1], mask[2], mask[3]);
  if (scissor) glEnable(GL_SCISSOR_TEST);
}

static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
  (void)pitch;
  if (data != RETRO_HW_FRAME_BUFFER_VALID) return; // duplicate frame: keep the previous picture
  frame_drawn = 1;
  if (width > 0 && height > 0) {
    frame_w = width;
    frame_h = height;
  }
}

// ---- libretro callbacks ----------------------------------------------------------------------------------------

static bool environment(unsigned cmd, void *data) {
  switch (cmd) {
    case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
      *(unsigned *)data = 2;
      return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
      option_defs = data ? ((const struct retro_core_options_v2 *)data)->definitions : NULL;
      return true;
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL: {
      const struct retro_core_options_v2_intl *intl = (const struct retro_core_options_v2_intl *)data;
      option_defs = intl && intl->us ? intl->us->definitions : NULL;
      return true;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE: {
      struct retro_variable *var = (struct retro_variable *)data;
      var->value = var->key ? option_value(var->key) : NULL;
      return var->value != NULL;
    }
    case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
      *(bool *)data = false;
      return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      return *(const enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_XRGB8888;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      ((struct retro_log_callback *)data)->log = log_printf;
      return true;
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      *(const char **)data = "/system";
      return true;
    case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
      *(const char **)data = "/saves";
      return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
      *(bool *)data = true;
      return true;
    case RETRO_ENVIRONMENT_SET_HW_RENDER: {
      struct retro_hw_render_callback *cb = (struct retro_hw_render_callback *)data;
      if (cb->context_type != RETRO_HW_CONTEXT_OPENGLES3 &&
          !(cb->context_type == RETRO_HW_CONTEXT_OPENGLES_VERSION && cb->version_major == 3 && cb->version_minor == 0))
        return false;
      cb->get_current_framebuffer = get_current_framebuffer;
      cb->get_proc_address = get_proc_address;
      hw = *cb;
      hw_ok = 1;
      return true;
    }
    case RETRO_ENVIRONMENT_SET_GEOMETRY: {
      const struct retro_game_geometry *g = (const struct retro_game_geometry *)data;
      if (hw_ok && fbo) ensure_fbo(g->max_width, g->max_height);
      return true;
    }
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
      const struct retro_system_av_info *av = (const struct retro_system_av_info *)data;
      if (av->timing.fps > 0) av_fps = av->timing.fps;
      if (av->timing.sample_rate > 0) av_rate = av->timing.sample_rate;
      if (hw_ok && fbo) ensure_fbo(av->geometry.max_width, av->geometry.max_height);
      return true;
    }
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
    case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
      return true;
    default:
      // No rumble, perf counters, JIT, threaded-renderer waits, Vulkan or background save states.
      return false;
  }
}

static size_t audio_batch(const int16_t *data, size_t frames) {
  size_t room = AUDIO_CAP - audio_frames;
  size_t n = frames < room ? frames : room;
  memcpy(audio_buf + audio_frames * 2, data, n * 2 * sizeof(int16_t));
  audio_frames += n;
  return frames;
}

static void audio_sample(int16_t left, int16_t right) {
  int16_t s[2] = {left, right};
  audio_batch(s, 1);
}

static void input_poll(void) {}

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  (void)port, (void)device, (void)index, (void)id;
  return 0; // unused: the patched input plugin asks nexo_n64_keys() directly
}

/** Controller `control`'s N64 state (BUTTONS.Value: button bits, X axis in bits 16–23, Y axis in 24–31). */
unsigned nexo_n64_keys(int control) { return control >= 0 && control < PORTS ? n64_keys[control] : 0; }

// ---- exports ---------------------------------------------------------------------------------------------------

EMSCRIPTEN_KEEPALIVE void nexo_init(void) {
  mkdir("/system", 0777);
  mkdir("/saves", 0777);
  retro_set_environment(environment);
  retro_set_video_refresh(video_refresh);
  retro_set_audio_sample(audio_sample);
  retro_set_audio_sample_batch(audio_batch);
  retro_set_input_poll(input_poll);
  retro_set_input_state(input_state);
  retro_init();
}

/**
 * Loads the game from `data` (the core keeps its own copy) and starts the renderer on the current WebGL context.
 * Returns 1 on success, 0 if the core refused the game, -1 if the renderer couldn't start.
 */
EMSCRIPTEN_KEEPALIVE int nexo_load(const uint8_t *data, size_t size) {
  struct retro_game_info info;
  memset(&info, 0, sizeof info);
  info.path = NULL; // loaded from memory (no .ndd / .gb side files)
  info.data = data;
  info.size = size;
  if (!retro_load_game(&info)) return 0;
  if (!hw_ok) return -1;
  struct retro_system_av_info av;
  memset(&av, 0, sizeof av);
  retro_get_system_av_info(&av);
  if (av.timing.fps > 0) av_fps = av.timing.fps;
  if (av.timing.sample_rate > 0) av_rate = av.timing.sample_rate;
  ensure_fbo(av.geometry.max_width, av.geometry.max_height);
  glBindFramebuffer(GL_FRAMEBUFFER, fbo);
  GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
  glBindFramebuffer(GL_FRAMEBUFFER, 0);
  if (status != GL_FRAMEBUFFER_COMPLETE) return -1;
  for (unsigned p = 0; p < PORTS; p++) retro_set_controller_port_device(p, RETRO_DEVICE_JOYPAD);
  if (hw.context_reset) hw.context_reset();
  return 1;
}

EMSCRIPTEN_KEEPALIVE double nexo_fps(void) { return av_fps; }
EMSCRIPTEN_KEEPALIVE double nexo_sample_rate(void) { return av_rate; }

/**
 * Runs one frame (to the next VI) and, when it produced a new picture, draws it on the canvas. Returns the number
 * of stereo audio frames it produced (at nexo_audio()).
 */
EMSCRIPTEN_KEEPALIVE unsigned nexo_run(void) {
  audio_frames = 0;
  frame_drawn = 0;
  retro_run();
  if (frame_drawn) present();
  return audio_frames;
}

EMSCRIPTEN_KEEPALIVE int nexo_frame_drawn(void) { return frame_drawn; }
EMSCRIPTEN_KEEPALIVE unsigned nexo_frame_width(void) { return frame_w; }
EMSCRIPTEN_KEEPALIVE unsigned nexo_frame_height(void) { return frame_h; }
EMSCRIPTEN_KEEPALIVE int16_t *nexo_audio(void) { return audio_buf; }

/** `value`: the N64 controller's BUTTONS word (see nexo_n64_keys). */
EMSCRIPTEN_KEEPALIVE void nexo_set_keys(unsigned port, unsigned value) {
  if (port < PORTS) n64_keys[port] = value;
}

/**
 * `hard` = 0: the console's reset button (an NMI the game handles, like retro_reset()); 1: power cycle (for games
 * that don't come back from a soft reset).
 */
EMSCRIPTEN_KEEPALIVE void nexo_reset(int hard) { CoreDoCommand(M64CMD_RESET, hard ? 1 : 0, NULL); }

EMSCRIPTEN_KEEPALIVE size_t nexo_state_size(void) { return retro_serialize_size(); }

// Saving / loading runs the emulation to the next VI (the core does it at an interrupt); its sound is dropped.
EMSCRIPTEN_KEEPALIVE int nexo_save_state(void *data, size_t size) {
  int ok = retro_serialize(data, size);
  audio_frames = 0;
  return ok;
}

extern int retro_savestate_result; // libretro.c: the core's verdict on the last save / load (1 = done)

EMSCRIPTEN_KEEPALIVE int nexo_load_state(const void *data, size_t size) {
  // retro_unserialize() says yes to anything; check the m64p save state's magic, then the core's own result.
  if (size < 8 || memcmp(data, "M64+SAVE", 8) != 0) return 0;
  int ok = retro_unserialize(data, size) && retro_savestate_result == 1;
  audio_frames = 0;
  return ok;
}
