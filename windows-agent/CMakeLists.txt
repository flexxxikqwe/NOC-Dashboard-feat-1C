cmake_minimum_required(VERSION 3.16)
project(noc_windows_agent VERSION 1.0.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

include_directories(
    include
    vendor/sqlite
)

# Исходники SQLite amalgamation
set(SQLITE_SOURCES
    vendor/sqlite/sqlite3.c
)
set_source_files_properties(${SQLITE_SOURCES} PROPERTIES
    COMPILE_FLAGS "-DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_WAL=1 -DSQLITE_OMIT_LOAD_EXTENSION=1"
)

# Общие исходники агента
set(AGENT_CORE_SOURCES
    src/json_lite.cpp
    src/crypto_hash.cpp
    src/sqlite_queue.cpp
    src/spool_watcher.cpp
    src/service_core.cpp
)

# Исполняемый файл службы Windows
add_executable(noc-agent
    src/main.cpp
    ${AGENT_CORE_SOURCES}
    ${SQLITE_SOURCES}
)

if (WIN32 OR MINGW)
    target_link_libraries(noc-agent PRIVATE advapi32 ws2_32 bcrypt)
    if (MINGW)
        set_target_properties(noc-agent PROPERTIES
            LINK_FLAGS "-static -static-libgcc -static-libstdc++"
        )
    endif()
endif()

# Тестовый исполняемый файл
add_executable(noc_agent_tests
    tests/test_agent.cpp
    ${AGENT_CORE_SOURCES}
    ${SQLITE_SOURCES}
)

if (WIN32 OR MINGW)
    target_link_libraries(noc_agent_tests PRIVATE advapi32 ws2_32 bcrypt)
else()
    target_link_libraries(noc_agent_tests PRIVATE pthread dl)
endif()

enable_testing()
add_test(NAME agent_tests COMMAND noc_agent_tests)
