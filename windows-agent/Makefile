CXX ?= g++
WIN64_CXX = x86_64-w64-mingw32-g++
WIN32_CXX = i686-w64-mingw32-g++
CC ?= gcc
WIN64_CC = x86_64-w64-mingw32-gcc
WIN32_CC = i686-w64-mingw32-gcc

CXXFLAGS = -std=c++17 -O2 -Wall -Wextra -Iinclude -Ivendor/sqlite
SQLITE_CFLAGS = -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_WAL=1 -DSQLITE_OMIT_LOAD_EXTENSION=1 -O2

SRCS = src/json_lite.cpp src/crypto_hash.cpp src/sqlite_queue.cpp src/spool_watcher.cpp src/service_core.cpp
SQLITE_SRC = vendor/sqlite/sqlite3.c

BIN_DIR = bin
BUILD_DIR = build

.PHONY: all test win64 win32 clean

all: test win64 win32

# Сборка и прогон нативных тестов (Linux / CI)
test: $(BIN_DIR)/test_agent
	./$(BIN_DIR)/test_agent

$(BIN_DIR)/test_agent: tests/test_agent.cpp $(SRCS) $(SQLITE_SRC)
	@mkdir -p $(BIN_DIR)
	$(CC) $(SQLITE_CFLAGS) -c $(SQLITE_SRC) -o $(BIN_DIR)/sqlite3.o
	$(CXX) $(CXXFLAGS) tests/test_agent.cpp $(SRCS) $(BIN_DIR)/sqlite3.o -lpthread -ldl -o $@

# Сборка Windows 64-bit исполняемого файла (.exe)
win64: $(BIN_DIR)/noc-agent-x64.exe

$(BIN_DIR)/noc-agent-x64.exe: src/main.cpp $(SRCS) $(SQLITE_SRC)
	@mkdir -p $(BIN_DIR)
	$(WIN64_CC) $(SQLITE_CFLAGS) -c $(SQLITE_SRC) -o $(BIN_DIR)/sqlite3-x64.o
	$(WIN64_CXX) $(CXXFLAGS) src/main.cpp $(SRCS) $(BIN_DIR)/sqlite3-x64.o \
		-static -static-libgcc -static-libstdc++ -ladvapi32 -lws2_32 -lbcrypt -o $@
	@echo "Built 64-bit Windows Agent: $@"

# Сборка Windows 32-bit исполняемого файла (.exe)
win32: $(BIN_DIR)/noc-agent-x86.exe

$(BIN_DIR)/noc-agent-x86.exe: src/main.cpp $(SRCS) $(SQLITE_SRC)
	@mkdir -p $(BIN_DIR)
	$(WIN32_CC) $(SQLITE_CFLAGS) -c $(SQLITE_SRC) -o $(BIN_DIR)/sqlite3-x86.o
	$(WIN32_CXX) $(CXXFLAGS) src/main.cpp $(SRCS) $(BIN_DIR)/sqlite3-x86.o \
		-static -static-libgcc -static-libstdc++ -ladvapi32 -lws2_32 -lbcrypt -o $@
	@echo "Built 32-bit Windows Agent: $@"

clean:
	rm -rf $(BIN_DIR) $(BUILD_DIR)
