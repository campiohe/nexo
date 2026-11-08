# Acquires the prebuilt LiveKit C++ SDK described by native/livekit-sdk.lock and imports LiveKit::livekit.
#
# The bundle is downloaded once into NEXO_DEPS_DIR (default: native/third_party), verified with SHA-256 and
# extracted next to the zip. A `.nexo-sha256` stamp records which archive a folder came from, so bumping the
# lock file re-downloads instead of silently reusing a stale SDK.
#
# Outputs: LIVEKIT_SDK_ROOT, LIVEKIT_SDK_VERSION, LIVEKIT_SDK_RUNTIME_DLLS (livekit.dll, livekit_ffi.dll).

set(NEXO_LIVEKIT_LOCK "${CMAKE_CURRENT_SOURCE_DIR}/../livekit-sdk.lock" CACHE FILEPATH "LiveKit SDK lock file")
set(NEXO_DEPS_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../third_party" CACHE PATH "Where downloaded dependencies are cached")
set(NEXO_LIVEKIT_SDK_DIR "" CACHE PATH "Use an already extracted LiveKit SDK instead of downloading (advanced)")

function(_nexo_read_lock lock_file)
  if(NOT EXISTS "${lock_file}")
    message(FATAL_ERROR "LiveKit lock file not found: ${lock_file}")
  endif()
  file(STRINGS "${lock_file}" _lines REGEX "^[a-z0-9_]+=")
  foreach(_line IN LISTS _lines)
    if(_line MATCHES "^([a-z0-9_]+)=(.*)$")
      set(LK_LOCK_${CMAKE_MATCH_1} "${CMAKE_MATCH_2}" PARENT_SCOPE)
    endif()
  endforeach()
endfunction()

if(NEXO_LIVEKIT_SDK_DIR)
  set(LIVEKIT_SDK_ROOT "${NEXO_LIVEKIT_SDK_DIR}")
  set(LIVEKIT_SDK_VERSION "custom")
else()
  _nexo_read_lock("${NEXO_LIVEKIT_LOCK}")
  foreach(_key version url sha256 dir)
    if(NOT LK_LOCK_${_key})
      message(FATAL_ERROR "${NEXO_LIVEKIT_LOCK} is missing '${_key}='")
    endif()
  endforeach()
  set(LIVEKIT_SDK_VERSION "${LK_LOCK_version}")
  set(LIVEKIT_SDK_ROOT "${NEXO_DEPS_DIR}/livekit-sdk-${LK_LOCK_version}")
  set(_stamp "${LIVEKIT_SDK_ROOT}/.nexo-sha256")
  set(_have "")
  if(EXISTS "${_stamp}")
    file(READ "${_stamp}" _have)
    string(STRIP "${_have}" _have)
  endif()
  if(NOT _have STREQUAL LK_LOCK_sha256)
    set(_zip "${NEXO_DEPS_DIR}/livekit-sdk-${LK_LOCK_version}.zip")
    message(STATUS "LiveKit SDK ${LK_LOCK_version}: downloading ${LK_LOCK_url}")
    file(DOWNLOAD "${LK_LOCK_url}" "${_zip}"
      EXPECTED_HASH SHA256=${LK_LOCK_sha256}
      TLS_VERIFY ON
      STATUS _status)
    list(GET _status 0 _code)
    if(NOT _code EQUAL 0)
      list(GET _status 1 _msg)
      file(REMOVE "${_zip}")
      message(FATAL_ERROR "LiveKit SDK download failed: ${_msg}\n"
        "Configure with -DNEXO_WITH_LIVEKIT=OFF to build everything except publish/.")
    endif()
    set(_tmp "${LIVEKIT_SDK_ROOT}.partial")
    file(REMOVE_RECURSE "${_tmp}" "${LIVEKIT_SDK_ROOT}")
    file(ARCHIVE_EXTRACT INPUT "${_zip}" DESTINATION "${_tmp}")
    if(NOT IS_DIRECTORY "${_tmp}/${LK_LOCK_dir}")
      message(FATAL_ERROR "LiveKit SDK archive does not contain ${LK_LOCK_dir}/")
    endif()
    file(RENAME "${_tmp}/${LK_LOCK_dir}" "${LIVEKIT_SDK_ROOT}")
    file(REMOVE_RECURSE "${_tmp}")
    file(REMOVE "${_zip}")
    file(WRITE "${_stamp}" "${LK_LOCK_sha256}\n")
  endif()
endif()

find_package(LiveKit CONFIG REQUIRED PATHS "${LIVEKIT_SDK_ROOT}" NO_DEFAULT_PATH)

# The bundle only ships a Release configuration. Debug builds of the helper use it too: they are compiled
# against the release CRT (/MD, see CMakeLists.txt) because the SDK passes std::string/std::vector across the
# DLL boundary and the debug CRT's layouts differ.
set_target_properties(LiveKit::livekit PROPERTIES
  MAP_IMPORTED_CONFIG_DEBUG Release
  MAP_IMPORTED_CONFIG_RELWITHDEBINFO Release
  MAP_IMPORTED_CONFIG_MINSIZEREL Release)

set(LIVEKIT_SDK_RUNTIME_DLLS
  "${LIVEKIT_SDK_ROOT}/bin/livekit.dll"
  "${LIVEKIT_SDK_ROOT}/bin/livekit_ffi.dll")
foreach(_dll IN LISTS LIVEKIT_SDK_RUNTIME_DLLS)
  if(NOT EXISTS "${_dll}")
    message(FATAL_ERROR "LiveKit SDK is missing ${_dll}")
  endif()
endforeach()
message(STATUS "LiveKit SDK ${LIVEKIT_SDK_VERSION}: ${LIVEKIT_SDK_ROOT}")
