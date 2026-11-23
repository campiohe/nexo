// Nexo's minimal libretro frontend for the PCSX ReARMed core (PlayStation), compiled together with the core into
// one WebAssembly module (see build.sh). It replaces RetroArch: the TypeScript side (../core.ts) writes the disc
// image (and an optional BIOS) into the module's in-memory file system, calls the nexo_* exports once per frame
// and reads the picture (RGBA, always 640×480) and the sound (stereo int16 at 44100 Hz) straight out of the
// module's memory. No threads, no OpenGL, no dynarec (interpreter only: WebAssembly can't run generated code).
//
// Files (Emscripten MEMFS, filled by the TS side): /disc/<image + tracks>, /system/<BIOS>.bin (optional: without
// one the core's built-in HLE BIOS runs the game). Memory card 1 lives in memory, formatted and empty at every
// load and lost when the game is closed (save states don't include it); memory card 2 is unplugged.
//
// Controllers: every pad is a DualShock (digital games read its buttons; analog games switch it to analog mode
// themselves, or the player presses L1+R1+Select like the real ANALOG button). With the multitap (default) the
// tap sits in PSX port 1: Nexo ports 0..3 are tap slots A..D (libretro ports 0..3), and PSX port 2 (libretro
// port 4) mirrors Nexo port 1, so 2-player games that don't know the multitap still see player 2 on port 2
// (the tap passes slot A through to them). Without it, Nexo ports 0/1 are PSX ports 1/2.
#include <stdarg.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "libretro.h"

#define RETRO_DEVICE_PSE_DUALSHOCK RETRO_DEVICE_SUBCLASS(RETRO_DEVICE_ANALOG, 1)
// The core's own private environment call (frontend/libretro.c).
#define RETRO_ENVIRONMENT_SET_SAVE_STATE_DISABLE_UNDO 0x800005

#define OUT_W 640
#define OUT_H 480
#define NEXO_PORTS 4
#define CORE_PORTS 8
// One NTSC frame is ~735 samples at 44100 Hz (PAL ~882); leave lots of room.
#define AUDIO_CAP 8192

static uint32_t frame_rgba[OUT_W * OUT_H];
static unsigned xmap[OUT_W];
static unsigned xmap_w;
static unsigned src_w, src_h;
static int16_t audio_buf[AUDIO_CAP * 2];
static unsigned audio_frames;
static uint16_t pads[NEXO_PORTS];
static int16_t axes[NEXO_PORTS][4]; // left x, left y, right x, right y (libretro range)
static bool multitap = true;
static bool frame_drawn;
static double av_fps = 59.94;
static double av_rate = 44100.0;
static enum retro_pixel_format pixel_format = RETRO_PIXEL_FORMAT_0RGB1555;
static const struct retro_core_option_v2_definition *option_defs;

// Options Nexo pins; everything else uses the core's defaults (read from its option definitions).
static const char *option_override(const char *key) {
  if (!strcmp(key, "pcsx_rearmed_multitap")) return multitap ? "port 1" : "disabled";
  if (!strcmp(key, "pcsx_rearmed_bios")) return "auto";                   // a BIOS in /system if any, else HLE
  if (!strcmp(key, "pcsx_rearmed_show_bios_bootlogo")) return "disabled"; // straight into the game
  if (!strcmp(key, "pcsx_rearmed_memcard1")) return "libretro";          // in memory
  if (!strcmp(key, "pcsx_rearmed_memcard2")) return "none";
  if (!strcmp(key, "pcsx_rearmed_rgb32_output")) return "enabled";       // 24-bit FMVs keep their colors
  if (!strcmp(key, "pcsx_rearmed_display_info")) return "disabled";      // no OSD messages (there's no OSD)
  if (!strcmp(key, "pcsx_rearmed_display_fps_v2")) return "disabled";
  if (!strcmp(key, "pcsx_rearmed_vibration")) return "disabled";
  if (!strcmp(key, "pcsx_rearmed_frameskip_type")) return "disabled";
  if (!strcmp(key, "pcsx_rearmed_neon_enhancement_enable")) return "disabled"; // native resolution
  return NULL;
}

static const char *option_value(const char *key) {
  const char *v = option_override(key);
  if (v) return v;
  for (const struct retro_core_option_v2_definition *d = option_defs; d && d->key; d++)
    if (!strcmp(d->key, key)) return d->default_value ? d->default_value : d->values[0].value;
  return NULL;
}

static void log_printf(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_INFO) return; // the TS side keeps the latest lines (shown when a game fails to load)
  char line[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line, sizeof line, fmt, ap);
  va_end(ap);
  fprintf(stderr, "[pcsx] %s", line);
}

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
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
      enum retro_pixel_format f = *(const enum retro_pixel_format *)data;
      if (f != RETRO_PIXEL_FORMAT_XRGB8888 && f != RETRO_PIXEL_FORMAT_RGB565) return false;
      pixel_format = f;
      return true;
    }
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
      *(const char **)data = "/system";
      return true;
    case RETRO_ENVIRONMENT_GET_CAN_DUPE:
      *(bool *)data = true;
      return true;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      ((struct retro_log_callback *)data)->log = log_printf;
      return true;
    case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO: {
      const struct retro_system_av_info *av = (const struct retro_system_av_info *)data;
      if (av->timing.fps > 0) av_fps = av->timing.fps;
      if (av->timing.sample_rate > 0) av_rate = av->timing.sample_rate;
      return true;
    }
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
    case RETRO_ENVIRONMENT_SET_MESSAGE:
    case RETRO_ENVIRONMENT_SET_MINIMUM_AUDIO_LATENCY:
    case RETRO_ENVIRONMENT_SET_SAVE_STATE_DISABLE_UNDO:
      return true;
    default:
      // No save directory (memory card 2 unplugged), no VFS / disk control / rumble / message interfaces, no
      // software framebuffer (the core renders into its own buffer), no audio buffer status (no frameskip).
      return false;
  }
}

static inline uint32_t xrgb_to_rgba(uint32_t p) {
  return 0xff000000u | ((p & 0xffu) << 16) | (p & 0xff00u) | ((p >> 16) & 0xffu);
}

static inline uint32_t rgb565_to_rgba(uint16_t p) {
  uint32_t r = (p >> 11) & 0x1f, g = (p >> 5) & 0x3f, b = p & 0x1f;
  r = (r << 3) | (r >> 2);
  g = (g << 2) | (g >> 4);
  b = (b << 3) | (b >> 2);
  return 0xff000000u | (b << 16) | (g << 8) | r;
}

// The PlayStation's picture is 256..640 wide and 224..480 (PAL up to 576) high depending on the game and the
// screen; whatever it is, a TV showed it full-screen 4:3. So every frame is stretched (nearest neighbour) to the
// fixed 640×480 output: the stream never changes size and the aspect ratio stays right.
static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data || !width || !height) return; // duplicate frame: keep the previous picture
  frame_drawn = true;
  src_w = width;
  src_h = height;
  if (xmap_w != width) {
    for (unsigned x = 0; x < OUT_W; x++) xmap[x] = x * width / OUT_W;
    xmap_w = width;
  }
  const bool rgb32 = pixel_format == RETRO_PIXEL_FORMAT_XRGB8888;
  unsigned prev_sy = ~0u;
  for (unsigned y = 0; y < OUT_H; y++) {
    uint32_t *dst = frame_rgba + y * OUT_W;
    unsigned sy = y * height / OUT_H;
    if (sy == prev_sy) {
      memcpy(dst, dst - OUT_W, OUT_W * sizeof(uint32_t));
      continue;
    }
    prev_sy = sy;
    const uint8_t *row = (const uint8_t *)data + (size_t)sy * pitch;
    if (rgb32) {
      const uint32_t *src = (const uint32_t *)row;
      for (unsigned x = 0; x < OUT_W; x++) dst[x] = xrgb_to_rgba(src[xmap[x]]);
    } else {
      const uint16_t *src = (const uint16_t *)row;
      for (unsigned x = 0; x < OUT_W; x++) dst[x] = rgb565_to_rgba(src[xmap[x]]);
    }
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
  if (audio_frames >= AUDIO_CAP) return;
  audio_buf[audio_frames * 2] = left;
  audio_buf[audio_frames * 2 + 1] = right;
  audio_frames++;
}

static void input_poll(void) {}

/** The Nexo port a libretro port reads, or -1 (nothing plugged there). See the header comment. */
static int nexo_port_of(unsigned port) {
  if (multitap) return port < NEXO_PORTS ? (int)port : port == NEXO_PORTS ? 1 : -1;
  return port < 2 ? (int)port : -1;
}

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  int p = nexo_port_of(port);
  if (p < 0) return 0;
  switch (device & RETRO_DEVICE_MASK) {
    case RETRO_DEVICE_JOYPAD:
      if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)pads[p];
      return id < 16 ? (pads[p] >> id) & 1 : 0;
    case RETRO_DEVICE_ANALOG:
      if (index > RETRO_DEVICE_INDEX_ANALOG_RIGHT || id > RETRO_DEVICE_ID_ANALOG_Y) return 0;
      return axes[p][index * 2 + id];
    default:
      return 0;
  }
}

EMSCRIPTEN_KEEPALIVE void nexo_init(void) {
  retro_set_environment(environment);
  retro_init();
  retro_set_video_refresh(video_refresh);
  retro_set_audio_sample(audio_sample);
  retro_set_audio_sample_batch(audio_batch);
  retro_set_input_poll(input_poll);
  retro_set_input_state(input_state);
}

/** Before nexo_load: plug the multitap into PSX port 1 (1, the default) or not (0). */
EMSCRIPTEN_KEEPALIVE void nexo_set_multitap(int on) { multitap = on != 0; }

/** Loads the game at `path` (a .cue / .bin / .iso / .img / .chd / .pbp / .exe in MEMFS). Returns 1 on success. */
EMSCRIPTEN_KEEPALIVE int nexo_load(const char *path) {
  struct retro_game_info info;
  memset(&info, 0, sizeof info);
  info.path = path;
  if (!retro_load_game(&info)) return 0;
  struct retro_system_av_info av;
  retro_get_system_av_info(&av);
  if (av.timing.fps > 0) av_fps = av.timing.fps;
  if (av.timing.sample_rate > 0) av_rate = av.timing.sample_rate;
  for (unsigned p = 0; p < CORE_PORTS; p++)
    retro_set_controller_port_device(p, nexo_port_of(p) >= 0 ? RETRO_DEVICE_PSE_DUALSHOCK : RETRO_DEVICE_NONE);
  return 1;
}

EMSCRIPTEN_KEEPALIVE double nexo_fps(void) { return av_fps; }
EMSCRIPTEN_KEEPALIVE double nexo_sample_rate(void) { return av_rate; }

/** Runs one frame. Returns the number of stereo audio frames it produced (read them at nexo_audio()). */
EMSCRIPTEN_KEEPALIVE unsigned nexo_run(void) {
  audio_frames = 0;
  frame_drawn = false;
  retro_run();
  return audio_frames;
}

EMSCRIPTEN_KEEPALIVE int nexo_frame_drawn(void) { return frame_drawn; }
/** 640×480 RGBA. */
EMSCRIPTEN_KEEPALIVE uint32_t *nexo_frame(void) { return frame_rgba; }
/** Size of the console's latest picture (before stretching to 640×480). Diagnostics. */
EMSCRIPTEN_KEEPALIVE unsigned nexo_src_width(void) { return src_w; }
EMSCRIPTEN_KEEPALIVE unsigned nexo_src_height(void) { return src_h; }
EMSCRIPTEN_KEEPALIVE int16_t *nexo_audio(void) { return audio_buf; }

/** `bits`: libretro joypad bits (bit n = RETRO_DEVICE_ID_JOYPAD_n); sticks in libretro's -32768..32767. */
EMSCRIPTEN_KEEPALIVE void nexo_set_pad(unsigned port, unsigned bits, int lx, int ly, int rx, int ry) {
  if (port >= NEXO_PORTS) return;
  pads[port] = (uint16_t)bits;
  axes[port][0] = (int16_t)lx;
  axes[port][1] = (int16_t)ly;
  axes[port][2] = (int16_t)rx;
  axes[port][3] = (int16_t)ry;
}

EMSCRIPTEN_KEEPALIVE void nexo_reset(void) { retro_reset(); }

EMSCRIPTEN_KEEPALIVE size_t nexo_state_size(void) { return retro_serialize_size(); }
EMSCRIPTEN_KEEPALIVE int nexo_save_state(void *data, size_t size) { return retro_serialize(data, size); }
EMSCRIPTEN_KEEPALIVE int nexo_load_state(const void *data, size_t size) { return retro_unserialize(data, size); }

EMSCRIPTEN_KEEPALIVE void nexo_unload(void) {
  retro_unload_game();
  retro_deinit();
}
