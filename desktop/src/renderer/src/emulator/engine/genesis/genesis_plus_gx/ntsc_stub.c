/* Stands in for Genesis Plus GX's core/ntsc/md_ntsc.c and sms_ntsc.c (blargg's NTSC filters, LGPL-2.1), which
   Nexo doesn't link so the shipped core carries no optional LGPL component. The filter is never enabled
   (nexo_frontend.c pins genesis_plus_gx_blargg_ntsc_filter to "disabled", so the renderer never calls the
   blitters); these definitions only satisfy the linker. */
#include "md_ntsc.h"
#include "sms_ntsc.h"

md_ntsc_setup_t const md_ntsc_composite = {0};
md_ntsc_setup_t const md_ntsc_svideo = {0};
md_ntsc_setup_t const md_ntsc_rgb = {0};
md_ntsc_setup_t const md_ntsc_monochrome = {0};
sms_ntsc_setup_t const sms_ntsc_composite = {0};
sms_ntsc_setup_t const sms_ntsc_svideo = {0};
sms_ntsc_setup_t const sms_ntsc_rgb = {0};
sms_ntsc_setup_t const sms_ntsc_monochrome = {0};

void md_ntsc_init(md_ntsc_t *ntsc, md_ntsc_setup_t const *setup) {
  (void)ntsc;
  (void)setup;
}

void sms_ntsc_init(sms_ntsc_t *ntsc, sms_ntsc_setup_t const *setup) {
  (void)ntsc;
  (void)setup;
}

void md_ntsc_blit(md_ntsc_t const *ntsc, MD_NTSC_IN_T const *table, unsigned char *input, int in_width, int vline) {
  (void)ntsc; (void)table; (void)input; (void)in_width; (void)vline;
}

void sms_ntsc_blit(sms_ntsc_t const *ntsc, SMS_NTSC_IN_T const *table, unsigned char *input, int in_width,
                   int vline) {
  (void)ntsc; (void)table; (void)input; (void)in_width; (void)vline;
}
