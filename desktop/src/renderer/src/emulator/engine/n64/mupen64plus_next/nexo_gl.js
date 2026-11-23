// Nexo's replacements for Emscripten's glMapBufferRange / glUnmapBuffer (linked with --js-library by ./build.sh).
//
// Emscripten emulates buffer mapping on WebGL 2 (which has none) with a malloc'd block uploaded by
// glUnmapBuffer, but returns NULL for GL_MAP_READ_BIT, GL_MAP_UNSYNCHRONIZED_BIT, or a write without an
// INVALIDATE bit. GLideN64 maps with exactly those: its vertex streaming (BufferedDrawer::_updateBuffer) maps
// WRITE | UNSYNCHRONIZED for every draw and memcpy's into the result without checking it, so each draw wrote
// the vertices over the start of the WebAssembly memory (the core's static data) until a corrupted function
// pointer crashed the core ("null function"; Mario Kart 64 at the start of a race). Its framebuffer reads
// (PBOReadBuffer, ColorBufferReaderWithPixelBuffer) map READ.
//
// Here:
// - READ maps get the buffer's current contents (getBufferSubData) and aren't uploaded back unless WRITE too.
// - WRITE maps upload the mapped range on unmap (or the flushed ranges with GL_MAP_FLUSH_EXPLICIT_BIT, as before).
// - UNSYNCHRONIZED is meaningless here (the upload happens at unmap anyway) and is ignored. A WRITE map without
//   an INVALIDATE bit should start with the buffer's contents; it does, unless it's UNSYNCHRONIZED: GLideN64
//   overwrites the whole range it maps that way, and reading a vertex buffer back on every draw would stall the
//   GPU each time.
addToLibrary({
  glMapBufferRange__deps: ['$emscriptenWebGLGetBufferBinding', '$emscriptenWebGLValidateMapBufferTarget', 'malloc'],
  glMapBufferRange: (target, offset, length, access) => {
    // GL_MAP_READ_BIT 0x1, WRITE 0x2, INVALIDATE_RANGE 0x4, INVALIDATE_BUFFER 0x8, FLUSH_EXPLICIT 0x10,
    // UNSYNCHRONIZED 0x20.
    if ((access & 0x3) == 0) {
      GL.recordError(0x502 /* GL_INVALID_OPERATION */);
      err('glMapBufferRange access must include MAP_READ or MAP_WRITE');
      return 0;
    }
    if (!emscriptenWebGLValidateMapBufferTarget(target)) {
      GL.recordError(0x500 /* GL_INVALID_ENUM */);
      err('GL_INVALID_ENUM in glMapBufferRange');
      return 0;
    }
    var mem = _malloc(length);
    if (!mem) {
      GL.recordError(0x505 /* GL_OUT_OF_MEMORY */);
      return 0;
    }
    var keepContents = (access & 0x1) || (access & (0x4 | 0x8 | 0x20)) == 0;
    if (keepContents && length > 0) GLctx.getBufferSubData(target, offset, HEAPU8, mem, length);
    var buffer = emscriptenWebGLGetBufferBinding(target);
    var mapping = (GL.mappedBuffers[buffer] ??= {});
    mapping.offset = offset;
    mapping.length = length;
    mapping.mem = mem;
    mapping.access = access;
    return mem;
  },

  glUnmapBuffer__deps: ['$emscriptenWebGLGetBufferBinding', '$emscriptenWebGLValidateMapBufferTarget', 'free'],
  glUnmapBuffer: (target) => {
    if (!emscriptenWebGLValidateMapBufferTarget(target)) {
      GL.recordError(0x500 /* GL_INVALID_ENUM */);
      err('GL_INVALID_ENUM in glUnmapBuffer');
      return 0;
    }
    var buffer = emscriptenWebGLGetBufferBinding(target);
    var mapping = GL.mappedBuffers[buffer];
    if (!mapping || !mapping.mem) {
      GL.recordError(0x502 /* GL_INVALID_OPERATION */);
      err('buffer was never mapped in glUnmapBuffer');
      return 0;
    }
    // Written and not flushed range by range (glFlushMappedBufferRange): upload the whole mapped range.
    if ((mapping.access & 0x2) && !(mapping.access & 0x10) && mapping.length > 0) {
      GLctx.bufferSubData(target, mapping.offset, HEAPU8, mapping.mem, mapping.length);
    }
    _free(mapping.mem);
    mapping.mem = 0;
    return 1;
  },
});
