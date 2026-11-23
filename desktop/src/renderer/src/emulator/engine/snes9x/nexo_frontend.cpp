// Nexo's minimal libretro frontend for the snes9x core, compiled together with the core into one WebAssembly
// module (see build.sh). It replaces RetroArch: the TypeScript side (../snes9x.ts) calls the nexo_* exports once
// per frame and reads the picture (RGBA, always 256×224) and the sound (stereo int16 at the core's own rate,
// ~32040 Hz) straight out of the module's memory. No files, no threads, no OpenGL.
//
// Controllers: libretro port 0 = SNES port 1 (a plain joypad), SNES port 2 holds a multitap whose 4 pads are
// libretro ports 1..4 (snes9x numbers them like that when port 0 isn't a multitap). Nexo uses ports 0..3.
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "libretro.h"

#define RETRO_DEVICE_JOYPAD_MULTITAP ((1 << 8) | RETRO_DEVICE_JOYPAD)

#define OUT_W 256
#define OUT_H 224
#define MAX_PORTS 8
// One NTSC frame is ~534 samples at 32040 Hz; leave lots of room (a frame never produces more than a few).
#define AUDIO_CAP 8192

static uint32_t frame_rgba[OUT_W * OUT_H];
static int16_t audio_buf[AUDIO_CAP * 2];
static unsigned audio_frames;
static uint16_t pads[MAX_PORTS];
static bool frame_drawn;
static double av_fps = 60.0988;
static double av_rate = 32040.0;
static const struct retro_core_option_v2_definition *option_defs;

// Options Nexo pins; everything else uses the core's defaults (read from its option definitions).
static const char *const OVERRIDES[][2] = {
    {"snes9x_overscan", "enabled"},           // crop to 224 lines, so PAL / overscan games fit 256×224 too
    {"snes9x_hires_blend", "merge"},          // 512-wide hi-res frames are merged to 256
    {"snes9x_blargg", "disabled"},            // no NTSC filter (it isn't even linked, see ntsc_stub.c)
    {"snes9x_msu1_enhanced_audio", "disabled"}, // keep the output at the DSP's own rate
    {"snes9x_randomize_memory", "disabled"},
    {"snes9x_up_down_allowed", "disabled"},
    {"snes9x_region", "auto"},
};

static const char *option_value(const char *key) {
  for (size_t i = 0; i < sizeof(OVERRIDES) / sizeof(OVERRIDES[0]); i++)
    if (!strcmp(OVERRIDES[i][0], key)) return OVERRIDES[i][1];
  for (const struct retro_core_option_v2_definition *d = option_defs; d && d->key; d++)
    if (!strcmp(d->key, key)) return d->default_value ? d->default_value : (d->values[0].value);
  return NULL;
}

static void log_printf(enum retro_log_level level, const char *fmt, ...) {
  if (level < RETRO_LOG_WARN) return;
  char line[512];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line, sizeof line, fmt, ap);
  va_end(ap);
  fprintf(stderr, "[snes9x] %s", line);
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
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
      return *(const enum retro_pixel_format *)data == RETRO_PIXEL_FORMAT_RGB565;
    case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
      return true;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
      ((struct retro_log_callback *)data)->log = log_printf;
      return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
      return true;
    default:
      // No system / save directory (no BS-X / Sufami Turbo BIOS), no A/V-enable negotiation (= everything on).
      return false;
  }
}

static inline uint32_t rgb565_to_rgba(uint16_t p) {
  uint32_t r = (p >> 11) & 0x1f, g = (p >> 5) & 0x3f, b = p & 0x1f;
  r = (r << 3) | (r >> 2);
  g = (g << 2) | (g >> 4);
  b = (b << 3) | (b >> 2);
  return 0xff000000u | (b << 16) | (g << 8) | r;
}

static inline uint16_t avg565(uint16_t a, uint16_t b) { return (a & b) + (((a ^ b) & 0xf7de) >> 1); }

static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data) return; // duplicate frame: keep the previous picture
  frame_drawn = true;
  // Interlaced (448/478 lines): every other line. Hi-res that wasn't merged (512 wide): average the pairs.
  unsigned ystep = height > 300 ? 2 : 1;
  unsigned rows = height / ystep;
  if (rows > OUT_H) rows = OUT_H;
  bool wide = width >= 512;
  for (unsigned y = 0; y < rows; y++) {
    const uint16_t *src = (const uint16_t *)((const uint8_t *)data + (size_t)y * ystep * pitch);
    uint32_t *dst = frame_rgba + y * OUT_W;
    if (wide)
      for (unsigned x = 0; x < OUT_W; x++) dst[x] = rgb565_to_rgba(avg565(src[2 * x], src[2 * x + 1]));
    else
      for (unsigned x = 0; x < OUT_W; x++) dst[x] = x < width ? rgb565_to_rgba(src[x]) : 0xff000000u;
  }
  for (unsigned y = rows; y < OUT_H; y++)
    for (unsigned x = 0; x < OUT_W; x++) frame_rgba[y * OUT_W + x] = 0xff000000u;
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

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  (void)index;
  if (port >= MAX_PORTS || (device & RETRO_DEVICE_MASK) != RETRO_DEVICE_JOYPAD) return 0;
  if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)pads[port];
  return id < 16 ? (pads[port] >> id) & 1 : 0;
}

extern "C" {

EMSCRIPTEN_KEEPALIVE void nexo_init(void) {
  retro_set_environment(environment);
  retro_init();
  retro_set_video_refresh(video_refresh);
  retro_set_audio_sample(audio_sample);
  retro_set_audio_sample_batch(audio_batch);
  retro_set_input_poll(input_poll);
  retro_set_input_state(input_state);
}

/** Loads the game from `data` (copied by the core). Returns 1 on success. */
EMSCRIPTEN_KEEPALIVE int nexo_load(const uint8_t *data, size_t size) {
  struct retro_game_info info;
  memset(&info, 0, sizeof info);
  info.path = "game.sfc";
  info.data = data;
  info.size = size;
  if (!retro_load_game(&info)) return 0;
  struct retro_system_av_info av;
  retro_get_system_av_info(&av);
  if (av.timing.fps > 0) av_fps = av.timing.fps;
  if (av.timing.sample_rate > 0) av_rate = av.timing.sample_rate;
  retro_set_controller_port_device(0, RETRO_DEVICE_JOYPAD);
  retro_set_controller_port_device(1, RETRO_DEVICE_JOYPAD_MULTITAP);
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
EMSCRIPTEN_KEEPALIVE uint32_t *nexo_frame(void) { return frame_rgba; }
EMSCRIPTEN_KEEPALIVE int16_t *nexo_audio(void) { return audio_buf; }

/** `bits`: libretro joypad bits (bit n = RETRO_DEVICE_ID_JOYPAD_n). */
EMSCRIPTEN_KEEPALIVE void nexo_set_pad(unsigned port, unsigned bits) {
  if (port < MAX_PORTS) pads[port] = (uint16_t)bits;
}

EMSCRIPTEN_KEEPALIVE void nexo_reset(void) { retro_reset(); }

EMSCRIPTEN_KEEPALIVE size_t nexo_state_size(void) { return retro_serialize_size(); }
EMSCRIPTEN_KEEPALIVE int nexo_save_state(void *data, size_t size) { return retro_serialize(data, size); }
EMSCRIPTEN_KEEPALIVE int nexo_load_state(const void *data, size_t size) { return retro_unserialize(data, size); }

EMSCRIPTEN_KEEPALIVE void nexo_unload(void) {
  retro_unload_game();
  retro_deinit();
}

} // extern "C"
