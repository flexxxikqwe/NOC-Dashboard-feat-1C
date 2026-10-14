#pragma once

#include <string>
#include <vector>
#include <map>
#include <memory>
#include <variant>
#include <optional>
#include <sstream>
#include "common.hpp"

namespace noc::json {

enum class Type {
    Null,
    Boolean,
    Number,
    String,
    Array,
    Object
};

class Value;
using Object = std::map<std::string, Value>;
using Array = std::vector<Value>;

class Value {
public:
    Value() : data_(std::monostate{}) {}
    Value(std::nullptr_t) : data_(std::monostate{}) {}
    Value(bool b) : data_(b) {}
    Value(int64_t i) : data_(static_cast<double>(i)) {}
    Value(double d) : data_(d) {}
    Value(std::string s) : data_(std::move(s)) {}
    Value(const char* s) : data_(std::string(s)) {}
    Value(Array a) : data_(std::move(a)) {}
    Value(Object o) : data_(std::move(o)) {}

    [[nodiscard]] Type GetType() const;
    [[nodiscard]] bool IsNull() const { return std::holds_alternative<std::monostate>(data_); }
    [[nodiscard]] bool IsBool() const { return std::holds_alternative<bool>(data_); }
    [[nodiscard]] bool IsNumber() const { return std::holds_alternative<double>(data_); }
    [[nodiscard]] bool IsString() const { return std::holds_alternative<std::string>(data_); }
    [[nodiscard]] bool IsArray() const { return std::holds_alternative<Array>(data_); }
    [[nodiscard]] bool IsObject() const { return std::holds_alternative<Object>(data_); }

    [[nodiscard]] bool AsBool(bool def = false) const;
    [[nodiscard]] double AsDouble(double def = 0.0) const;
    [[nodiscard]] int64_t AsInt64(int64_t def = 0) const;
    [[nodiscard]] const std::string& AsString() const;
    [[nodiscard]] const Array& AsArray() const;
    [[nodiscard]] const Object& AsObject() const;

    [[nodiscard]] bool HasKey(const std::string& key) const;
    [[nodiscard]] const Value* Find(const std::string& key) const;
    [[nodiscard]] const Value& operator[](const std::string& key) const;
    [[nodiscard]] const Value& operator[](size_t index) const;

    [[nodiscard]] std::string Dump(int indent = 0) const;

private:
    std::variant<std::monostate, bool, double, std::string, Array, Object> data_;
};

// Строгий парсер JSON
class Parser {
public:
    static bool Parse(const std::string& json_text, Value& out_value, std::string& out_error);
    static bool ParseSpoolEnvelope(const std::string& json_text, SpoolEnvelope& out_envelope, std::string& out_error);
    
    // Проверка UTF-8 и отсутствия BOM
    static bool ValidateUtf8NoBom(const std::string& text, std::string& out_error);

private:
    explicit Parser(std::string_view text) : text_(text), pos_(0) {}

    bool ParseValue(Value& val);
    bool ParseObject(Value& val);
    bool ParseArray(Value& val);
    bool ParseString(std::string& str);
    bool ParseNumber(Value& val);
    bool ParseLiteral(const std::string& lit, Value& val);

    void SkipWhitespace();
    [[nodiscard]] char Peek() const;
    char Get();
    [[nodiscard]] bool Eof() const;
    void SetError(const std::string& msg);

    std::string_view text_;
    size_t pos_ = 0;
    size_t depth_ = 0;
    static constexpr size_t MAX_NESTING_DEPTH = 32;
    std::string error_;
};

} // namespace noc::json
