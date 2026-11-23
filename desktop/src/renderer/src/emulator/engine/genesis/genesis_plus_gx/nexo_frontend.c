// Nexo's minimal libretro frontend for the Genesis Plus GX core, compiled together with the core into one
// WebAssembly module (see build.sh). It replaces RetroArch: the TypeScript side (../core.ts) calls the nexo_*
// exports once per frame and reads the picture (RGBA, always 320×224) and the sound (stereo int16 at 44100 Hz)
// straight out of the module's memory. No files, no threads, no OpenGL.
//
// Picture: the Mega Drive draws 320 (H40) or 256 (H32) pixels per line, 224 lines (NTSC / PAL V28) or 240 (PAL
// V30). Every frame lands in the same 320×224 buffer: a 256-wide frame is stretched to 320 (each output pixel is
// the area-weighted mix of the 1–2 source pixels it covers: on a TV both modes fill the same width), 240 lines are
// cropped to the middle 224 (TVs hid those lines in the overscan anyway), interlaced 448/480-line frames keep
// every other line.
//
// Controllers: 6-button pads (games that only know 3-button pads read them as 3-button pads; holding Mode while a
// game boots makes the pad report itself as a 3-button one, like on the real pad). For 4 players both console ports
// are configured as Sega Team Players, and the port handlers (io_ctrl.c is compiled with teamplayer_N_read / write
// renamed to nexo_port_N_read / write, see build.sh) decide per access what the game gets:
//   - EA 4-Way Play (both ports: pads 1–4 selected through port B) once the game drives port B's UP/DOWN lines as
//     outputs, which only the 4-Way Play protocol does (EA's games, SGDK's joypad code: they probe for it at boot);
//   - a Sega Team Player on port A for the whole session when the cartridge header lists it ('4' in the I/O
//     support field): games find it through its peripheral ID, which can't be told apart from a plain pad read;
//   - a Team Player on a port while the game drives that port's TR line as an output (the Team Player handshake; a
//     plain pad needs TR as an input: it's button C / Start), for games that skip the ID check;
//   - otherwise a plain 6-button pad, so every 1–2 player game sees ordinary pads on both ports.
// Nexo ports 0..3 map onto whichever is in use: 4-Way Play / Team Player on port A = players 1–4; Team Player on
// port B = player 1 on port A + players 2–4 on the tap; plain = players 1 and 2 on ports A and B; J-Cart games
// (Micro Machines 2…: two extra pads on the cartridge) = players 3 and 4 on the cartridge.
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <emscripten/emscripten.h>

#include "shared.h"
#include "gamepad.h"
#include "teamplayer.h"
#include "libretro.h"

#define OUT_W 320
#define OUT_H 224
#define NEXO_PORTS 4
#define RETRO_DEVICE_MDPAD_6B RETRO_DEVICE_SUBCLASS(RETRO_DEVICE_JOYPAD, 1)
#define RETRO_DEVICE_MDPAD_6B_TEAMPLAYER RETRO_DEVICE_SUBCLASS(RETRO_DEVICE_JOYPAD, 6)
// One NTSC frame is ~735 samples at 44100 Hz (PAL ~882); leave lots of room.
#define AUDIO_CAP 8192
// Save states carry this prefix + a hash of the game, so a state from another game is refused.
#define STATE_MAGIC 0x444d584eu /* "NXMD" */
#define STATE_PREFIX 8

static uint32_t frame_rgba[OUT_W * OUT_H];
static uint32_t row_rgba[1024];
static int16_t audio_buf[AUDIO_CAP * 2];
static unsigned audio_frames;
static uint16_t pads[NEXO_PORTS];
static bool frame_drawn;
static double av_fps = 59.922743;
static double av_rate = 44100.0;
static const struct retro_core_option_v2_definition *option_defs;
static uint8_t *rom_copy;
static size_t rom_size;
static uint32_t rom_hash;
static bool jcart;
static bool tp_header; // the cartridge header lists the Team Player: port A is one for the whole session
static int tp_a, tp_b; // the Team Player protocol is active on port A / B

// Horizontal resampling table for the current source width (see video_refresh).
static unsigned scale_width;
static uint16_t scale_i0[OUT_W];
static uint16_t scale_w0[OUT_W]; // weight of source pixel i0 in 1/256 (the rest goes to i0 + 1)

// Options Nexo pins; everything else uses the core's defaults (read from its option definitions).
static const char *const OVERRIDES[][2] = {
    {"genesis_plus_gx_system_hw", "auto"},         // = Mega Drive for the "game.md" nexo_load names the file
    {"genesis_plus_gx_region_detect", "auto"},      // PAL games run at 50 Hz, NTSC at 60 Hz
    {"genesis_plus_gx_bios", "disabled"},           // no TMSS boot ROM (none is shipped)
    {"genesis_plus_gx_add_on", "none"},             // no Mega CD / MegaSD probing next to the cartridge
    {"genesis_plus_gx_lock_on", "disabled"},
    {"genesis_plus_gx_overscan", "disabled"},       // the active picture only: 320/256 × 224/240
    {"genesis_plus_gx_left_border", "disabled"},
    {"genesis_plus_gx_blargg_ntsc_filter", "disabled"}, // not even linked (ntsc_stub.c)
    {"genesis_plus_gx_lcd_filter", "disabled"},
    {"genesis_plus_gx_render", "single field"},     // interlaced modes at 224 lines
    {"genesis_plus_gx_frameskip", "disabled"},
    {"genesis_plus_gx_ym2612", "mame (ym2612)"},    // the Nuked OPN2 core (LGPL) isn't built
    {"genesis_plus_gx_sound_output", "stereo"},
    {"genesis_plus_gx_no_sprite_limit", "disabled"},
    {"genesis_plus_gx_enhanced_vscroll", "disabled"},
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
  fprintf(stderr, "[genesis_plus_gx] %s", line);
}

static struct retro_game_info_ext game_ext;

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
    case RETRO_ENVIRONMENT_GET_GAME_INFO_EXT:
      // The game is in memory: the core copies it from here instead of opening a file.
      *(const struct retro_game_info_ext **)data = &game_ext;
      return true;
    case RETRO_ENVIRONMENT_SET_GEOMETRY:
    case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
    case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
    case RETRO_ENVIRONMENT_SET_PERFORMANCE_LEVEL:
    case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
    case RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE:
    case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS:
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
      return true;
    default:
      // No system / save directory (no BIOS, no Mega CD), no VFS (the core's file access just fails: the game is
      // handed over in memory), no A/V-enable negotiation (= everything on), no audio buffer status (no frameskip).
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

static inline uint32_t mix(uint32_t a, uint32_t b, uint32_t wa) {
  uint32_t wb = 256 - wa;
  uint32_t r = ((a & 0xff) * wa + (b & 0xff) * wb) >> 8;
  uint32_t g = (((a >> 8) & 0xff) * wa + ((b >> 8) & 0xff) * wb) >> 8;
  uint32_t bl = (((a >> 16) & 0xff) * wa + ((b >> 16) & 0xff) * wb) >> 8;
  return 0xff000000u | (bl << 16) | (g << 8) | r;
}

// Output pixel x covers source [x*w/320, (x+1)*w/320): less than one source pixel wide (w < 320), so it overlaps
// one or two of them.
static void build_scale(unsigned w) {
  scale_width = w;
  for (unsigned x = 0; x < OUT_W; x++) {
    unsigned s = x * w, e = (x + 1) * w, i0 = s / OUT_W, boundary = (i0 + 1) * OUT_W;
    scale_i0[x] = (uint16_t)i0;
    scale_w0[x] = (uint16_t)(e <= boundary ? 256 : ((boundary - s) * 256) / w);
  }
}

static void black_row(uint32_t *row) {
  for (unsigned x = 0; x < OUT_W; x++) row[x] = 0xff000000u;
}

static void video_refresh(const void *data, unsigned width, unsigned height, size_t pitch) {
  if (!data || !width || !height) return; // duplicate frame: keep the previous picture
  frame_drawn = true;
  unsigned ystep = height > 300 ? 2 : 1;
  unsigned rows = height / ystep;
  unsigned skip = rows > OUT_H ? (rows - OUT_H) / 2 : 0; // PAL V30: crop to the middle 224 lines
  unsigned top = rows < OUT_H ? (OUT_H - rows) / 2 : 0;  // shorter frames: centered
  if (rows - skip > OUT_H) rows = OUT_H + skip;
  if (width > sizeof(row_rgba) / sizeof(row_rgba[0])) width = sizeof(row_rgba) / sizeof(row_rgba[0]);
  if (width < OUT_W && width != scale_width) build_scale(width);
  unsigned xoff = width > OUT_W ? (width - OUT_W) / 2 : 0;

  for (unsigned y = 0; y < top; y++) black_row(frame_rgba + y * OUT_W);
  unsigned out_y = top;
  for (unsigned y = skip; y < rows && out_y < OUT_H; y++, out_y++) {
    const uint16_t *src = (const uint16_t *)((const uint8_t *)data + (size_t)y * ystep * pitch);
    uint32_t *dst = frame_rgba + out_y * OUT_W;
    if (width >= OUT_W) {
      for (unsigned x = 0; x < OUT_W; x++) dst[x] = rgb565_to_rgba(src[x + xoff]);
    } else {
      for (unsigned x = 0; x < width; x++) row_rgba[x] = rgb565_to_rgba(src[x]);
      row_rgba[width] = row_rgba[width - 1];
      for (unsigned x = 0; x < OUT_W; x++) {
        unsigned i0 = scale_i0[x], w0 = scale_w0[x];
        dst[x] = w0 >= 256 ? row_rgba[i0] : mix(row_rgba[i0], row_rgba[i0 + 1], w0);
      }
    }
  }
  for (; out_y < OUT_H; out_y++) black_row(frame_rgba + out_y * OUT_W);
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

// ---- Automatic multitap (see the top of the file) ----------------------------------------------------------------
// io_reg[4] / io_reg[5]: the I/O direction ("control") registers of ports A / B (bit set = pin driven as output:
// 6 TH, 5 TR, 4 TL, 3..0 RIGHT LEFT DOWN UP). The core updates them before calling the port's write handler.

static inline int wayplay_on(void) { return input.system[1] == SYSTEM_TEAMPLAYER && (io_reg[5] & 0x03) != 0; }

static inline int teamplayer_on_a(void) { return tp_header || (io_reg[4] & 0x20); }

unsigned char nexo_port_1_read(void) {
  if (wayplay_on()) return wayplay_1_read();
  if (teamplayer_on_a()) return teamplayer_1_read();
  return gamepad_1_read();
}

void nexo_port_1_write(unsigned char data, unsigned char mask) {
  if (wayplay_on()) {
    wayplay_1_write(data, mask);
    return;
  }
  if (tp_header || (mask & 0x20)) {
    if (!tp_a) teamplayer_reset(0);
    tp_a = 1;
    teamplayer_1_write(data, mask);
    return;
  }
  tp_a = 0;
  gamepad_1_write(data, mask);
}

unsigned char nexo_port_2_read(void) {
  if (wayplay_on()) return wayplay_2_read();
  if (io_reg[5] & 0x20) return teamplayer_2_read();
  return gamepad_2_read();
}

void nexo_port_2_write(unsigned char data, unsigned char mask) {
  if (mask & 0x03) {
    wayplay_2_write(data, mask);
    return;
  }
  if (mask & 0x20) {
    if (!tp_b) teamplayer_reset(1);
    tp_b = 1;
    teamplayer_2_write(data, mask);
    return;
  }
  tp_b = 0;
  gamepad_2_write(data, mask);
}

/** libretro player `player` (the core numbers connected pads in order: port A's 4, then port B's / J-Cart's) →
    Nexo port, or -1. */
static int nexo_port_for(unsigned player) {
  // 4-Way Play (pads 0..3, selected through port B) or a Team Player on port A (pads 0..3).
  bool all_on_a = wayplay_on() || teamplayer_on_a();
  if (player < 4) return all_on_a ? (int)player : (player == 0 ? 0 : -1);
  if (all_on_a) return -1;
  // Port B's pad (or its Team Player's first pad), then the Team Player's next two, or the J-Cart's two pads.
  return player <= 6 ? (int)player - 3 : -1;
}

static void input_poll(void) {}

static int16_t input_state(unsigned port, unsigned device, unsigned index, unsigned id) {
  (void)index;
  if ((device & RETRO_DEVICE_MASK) != RETRO_DEVICE_JOYPAD) return 0;
  int n = nexo_port_for(port);
  if (n < 0 || n >= NEXO_PORTS) return 0;
  if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)pads[n];
  return id < 16 ? (pads[n] >> id) & 1 : 0;
}

static void connect_pads(void) {
  for (int i = 0; i < MAX_INPUTS; i++) config.input[i].padtype = DEVICE_PAD6B;
  tp_a = tp_b = 0;
  retro_set_controller_port_device(0, RETRO_DEVICE_MDPAD_6B_TEAMPLAYER);
  // J-Cart games read players 3–4 from the cartridge: port B stays a plain pad so the core wires those up.
  retro_set_controller_port_device(1, jcart ? RETRO_DEVICE_MDPAD_6B : RETRO_DEVICE_MDPAD_6B_TEAMPLAYER);
}

static uint32_t fnv1a(const uint8_t *p, size_t n) {
  uint32_t h = 0x811c9dc5u;
  for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 0x01000193u;
  return h;
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

/** Loads a Mega Drive cartridge (raw .md/.gen/.bin or interleaved .smd) from `data` (copied). Returns 1 on success. */
EMSCRIPTEN_KEEPALIVE int nexo_load(const uint8_t *data, size_t size) {
  rom_copy = (uint8_t *)malloc(size);
  if (!rom_copy) return 0;
  memcpy(rom_copy, data, size);
  rom_size = size;
  rom_hash = fnv1a(rom_copy, rom_size);

  memset(&game_ext, 0, sizeof game_ext);
  game_ext.full_path = "/nexo/game.md";
  game_ext.dir = "/nexo";
  game_ext.name = "game";
  game_ext.ext = "md";
  game_ext.data = rom_copy;
  game_ext.size = rom_size;
  struct retro_game_info info;
  memset(&info, 0, sizeof info);
  info.path = game_ext.full_path;
  info.data = rom_copy;
  info.size = rom_size;
  if (!retro_load_game(&info) || system_hw != SYSTEM_MD) {
    free(rom_copy);
    rom_copy = NULL;
    return 0;
  }
  struct retro_system_av_info av;
  retro_get_system_av_info(&av);
  if (av.timing.fps > 0) av_fps = av.timing.fps;
  if (av.timing.sample_rate > 0) av_rate = av.timing.sample_rate;
  jcart = (cart.special & HW_J_CART) != 0;
  tp_header = !jcart && (rominfo.peripherals & (1 << 7)) != 0; // '4' (see peripheralinfo in core/loadrom.c)
  connect_pads();
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

/** `bits`: libretro joypad bits (bit n = RETRO_DEVICE_ID_JOYPAD_n) of Nexo port `port` (0..3). */
EMSCRIPTEN_KEEPALIVE void nexo_set_pad(unsigned port, unsigned bits) {
  if (port < NEXO_PORTS) pads[port] = (uint16_t)bits;
}

/** The console's reset button (soft reset: the 68000 restarts, RAM and the pads stay). */
EMSCRIPTEN_KEEPALIVE void nexo_reset(void) {
  retro_reset();
  tp_a = tp_b = 0;
}

EMSCRIPTEN_KEEPALIVE size_t nexo_state_size(void) { return STATE_PREFIX + retro_serialize_size(); }

EMSCRIPTEN_KEEPALIVE int nexo_save_state(uint8_t *data, size_t size) {
  if (size != nexo_state_size()) return 0;
  uint32_t head[2] = {STATE_MAGIC, rom_hash};
  memcpy(data, head, STATE_PREFIX);
  return retro_serialize(data + STATE_PREFIX, size - STATE_PREFIX);
}

EMSCRIPTEN_KEEPALIVE int nexo_load_state(const uint8_t *data, size_t size) {
  if (size != nexo_state_size()) return 0;
  uint32_t head[2];
  memcpy(head, data, STATE_PREFIX);
  if (head[0] != STATE_MAGIC || head[1] != rom_hash) return 0;
  if (!retro_unserialize(data + STATE_PREFIX, size - STATE_PREFIX)) return 0;
  tp_a = teamplayer_on_a() != 0;
  tp_b = (io_reg[5] & 0x20) != 0;
  return 1;
}

EMSCRIPTEN_KEEPALIVE void nexo_unload(void) {
  retro_unload_game();
  retro_deinit();
  free(rom_copy);
  rom_copy = NULL;
}
