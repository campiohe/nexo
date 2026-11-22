/* Stands in for snes9x's filter/snes_ntsc.c (blargg's NTSC filter, LGPL-2.1), which Nexo doesn't link so the
   shipped core stays under the snes9x license alone. The filter is never enabled (nexo_frontend.cpp pins
   snes9x_blargg to "disabled"); these definitions only satisfy the linker. */
#include "filter/snes_ntsc.h"

snes_ntsc_setup_t const snes_ntsc_composite = {0};
snes_ntsc_setup_t const snes_ntsc_svideo = {0};
snes_ntsc_setup_t const snes_ntsc_rgb = {0};
snes_ntsc_setup_t const snes_ntsc_monochrome = {0};
unsigned int snes_ntsc_scanline_offset = 0;
unsigned short snes_ntsc_scanline_mask = 0;

void snes_ntsc_init(snes_ntsc_t *ntsc, snes_ntsc_setup_t const *setup) {
  (void)ntsc;
  (void)setup;
}

void snes_ntsc_blit(snes_ntsc_t const *ntsc, SNES_NTSC_IN_T const *input, long in_row_width, int burst_phase,
                    int in_width, int in_height, void *rgb_out, long out_pitch) {
  (void)ntsc; (void)input; (void)in_row_width; (void)burst_phase; (void)in_width; (void)in_height;
  (void)rgb_out; (void)out_pitch;
}

void snes_ntsc_blit_hires(snes_ntsc_t const *ntsc, SNES_NTSC_IN_T const *input, long in_row_width, int burst_phase,
                          int in_width, int in_height, void *rgb_out, long out_pitch) {
  (void)ntsc; (void)input; (void)in_row_width; (void)burst_phase; (void)in_width; (void)in_height;
  (void)rgb_out; (void)out_pitch;
}
