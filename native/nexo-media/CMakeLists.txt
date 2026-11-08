# nexo-media.exe: the native capture/encode/publish helper (docs/SPEC-BETA.md §4, §9).
#
#   cmake --preset windows-release
#   cmake --build --preset windows-release
#   ctest --preset windows-release
#   cmake --install build/windows-release --prefix ../out
#
# Run from a Visual Studio developer shell (vcvars64.bat). scripts/native-build.sh does all of this from WSL.
cmake_minimum_required(VERSION 3.25)

project(nexo_media VERSION 0.4.0 LANGUAGES CXX)
set(NEXO_MEDIA_VERSION "${PROJECT_VERSION}-dev" CACHE STRING "Version reported in capabilities")

if(NOT WIN32 OR NOT MSVC)
  message(FATAL_ERROR "nexo-media is Windows-only and builds with MSVC (see scripts/native-build.sh)")
endif()

option(NEXO_WITH_LIVEKIT "Link the LiveKit C++ SDK (publish/). OFF builds everything else, with a null publisher" ON)
option(NEXO_BUILD_TESTS "Build the unit tests (ctest)" ON)
option(NEXO_ANALYZE "Compile with /analyze (MSVC static analysis, slow)" OFF)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# Release CRT for every configuration: livekit.dll is a release build and its C++ API passes STL types.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreadedDLL")
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

# ── Dependencies ───────────────────────────────────────────────────────────────────────────────────────

include(FetchContent)
FetchContent_Declare(nlohmann_json
  URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
  URL_HASH SHA256=42f6e95cad6ec532fd372391373363b62a14af6d771056dbfc86160e6dfff7aa
  DOWNLOAD_EXTRACT_TIMESTAMP ON)
FetchContent_MakeAvailable(nlohmann_json)

if(NEXO_WITH_LIVEKIT)
  include(cmake/LiveKitSdk.cmake)
endif()

# ── Common compile settings ────────────────────────────────────────────────────────────────────────────

add_library(nexo_options INTERFACE)
target_compile_options(nexo_options INTERFACE
  /W4 /permissive- /utf-8 /EHsc /Zc:__cplusplus /Zc:preprocessor /bigobj /Zi
  $<$<BOOL:${NEXO_ANALYZE}>:/analyze /analyze:external->)
target_compile_definitions(nexo_options INTERFACE
  WIN32_LEAN_AND_MEAN NOMINMAX UNICODE _UNICODE _WIN32_WINNT=0x0A00 NTDDI_VERSION=0x0A00000F
  NEXO_MEDIA_VERSION="${NEXO_MEDIA_VERSION}"
  $<$<BOOL:${NEXO_WITH_LIVEKIT}>:NEXO_WITH_LIVEKIT=1>)
target_include_directories(nexo_options INTERFACE "${CMAKE_CURRENT_SOURCE_DIR}/src")
target_link_options(nexo_options INTERFACE /DEBUG:FULL /OPT:REF /OPT:ICF)

# ── Pure logic (no Windows media APIs): unit-testable ──────────────────────────────────────────────────

add_library(nexo_core STATIC
  src/common/redact.cpp
  src/ipc/protocol.cpp
  src/video/annexb.cpp
  src/video/output_size.cpp
  src/video/pacer.cpp)
target_link_libraries(nexo_core PUBLIC nexo_options nlohmann_json::nlohmann_json)

# ── Windows capture / convert / encode pipeline ────────────────────────────────────────────────────────

add_library(nexo_win STATIC
  src/common/log.cpp
  src/common/win_error.cpp
  src/d3d/device.cpp
  src/capture/frame_ring.cpp
  src/capture/wgc.cpp
  src/capture/test_pattern.cpp
  src/video/convert.cpp
  src/video/encoder_mf.cpp
  src/sys/system_info.cpp
  src/publish/null_publisher.cpp
  src/share/share.cpp
  src/ipc/server.cpp)
target_link_libraries(nexo_win PUBLIC nexo_core
  d3d11 dxgi mfplat mf mfuuid strmiids windowsapp)

if(NEXO_WITH_LIVEKIT)
  # publish/: the only code that sees the SDK, so SDK upgrades stay contained (SPEC-BETA §4.8).
  add_library(nexo_publish STATIC src/publish/livekit.cpp)
  target_link_libraries(nexo_publish PUBLIC nexo_win PRIVATE LiveKit::livekit)
endif()

add_executable(nexo-media src/main.cpp)
target_link_libraries(nexo-media PRIVATE nexo_win $<$<BOOL:${NEXO_WITH_LIVEKIT}>:nexo_publish>)

if(NEXO_WITH_LIVEKIT)
  # Keep the SDK DLLs next to the exe in the build tree, so ctest and manual runs work without installing.
  add_custom_command(TARGET nexo-media POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${LIVEKIT_SDK_RUNTIME_DLLS} "$<TARGET_FILE_DIR:nexo-media>"
    VERBATIM)
endif()

# ── Install: everything flat in the prefix (native/out), ready for electron-builder extraResources ─────

install(TARGETS nexo-media RUNTIME DESTINATION .)
if(NEXO_WITH_LIVEKIT)
  install(FILES ${LIVEKIT_SDK_RUNTIME_DLLS} DESTINATION .)
endif()
# App-local VC++ runtime, so friends don't need the redistributable installed (SPEC-BETA §9.3).
set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION .)
set(CMAKE_INSTALL_SYSTEM_RUNTIME_LIBS_NO_WARNINGS ON)
include(InstallRequiredSystemLibraries)

# ── Tests ──────────────────────────────────────────────────────────────────────────────────────────────

if(NEXO_BUILD_TESTS)
  enable_testing()
  add_executable(nexo-media-tests
    tests/test_main.cpp
    tests/test_annexb.cpp
    tests/test_output_size.cpp
    tests/test_pacer.cpp
    tests/test_protocol.cpp)
  target_link_libraries(nexo-media-tests PRIVATE nexo_core)
  foreach(_suite annexb output_size pacer protocol)
    add_test(NAME unit.${_suite} COMMAND nexo-media-tests ${_suite})
  endforeach()
  # Smoke test of the real exe: must print capabilities and exit 0 even on a GPU-less CI runner.
  add_test(NAME selftest COMMAND nexo-media --selftest)
  set_tests_properties(selftest PROPERTIES PASS_REGULAR_EXPRESSION "\"osBuild\"")
endif()
