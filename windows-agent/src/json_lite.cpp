#include "json_lite.hpp"
#include <cctype>
#include <cmath>
#include <charconv>

namespace noc::json {

Type Value::GetType() const {
    if (std::holds_alternative<std::monostate>(data_)) return Type::Null;
    if (std::holds_alternative<bool>(data_)) return Type::Boolean;
    if (std::holds_alternative<double>(data_)) return Type::Number;
    if (std::holds_alternative<std::string>(data_)) return Type::String;
    if (std::holds_alternative<Array>(data_)) return Type::Array;
    return Type::Object;
}

bool Value::AsBool(bool def) const {
    if (auto p = std::get_if<bool>(&data_)) return *p;
    return def;
}

double Value::AsDouble(double def) const {
    if (auto p = std::get_if<double>(&data_)) return *p;
    return def;
}

int64_t Value::AsInt64(int64_t def) const {
    if (auto p = std::get_if<double>(&data_)) return static_cast<int64_t>(*p);
    return def;
}

static const std::string kEmptyString = "";
static const Array kEmptyArray = {};
static const Object kEmptyObject = {};
static const Value kNullValue = Value();

const std::string& Value::AsString() const {
    if (auto p = std::get_if<std::string>(&data_)) return *p;
    return kEmptyString;
}

const Array& Value::AsArray() const {
    if (auto p = std::get_if<Array>(&data_)) return *p;
    return kEmptyArray;
}

const Object& Value::AsObject() const {
    if (auto p = std::get_if<Object>(&data_)) return *p;
    return kEmptyObject;
}

bool Value::HasKey(const std::string& key) const {
    if (auto p = std::get_if<Object>(&data_)) {
        return p->find(key) != p->end();
    }
    return false;
}

const Value* Value::Find(const std::string& key) const {
    if (auto p = std::get_if<Object>(&data_)) {
        auto it = p->find(key);
        if (it != p->end()) return &it->second;
    }
    return nullptr;
}

const Value& Value::operator[](const std::string& key) const {
    const Value* ptr = Find(key);
    return ptr ? *ptr : kNullValue;
}

const Value& Value::operator[](size_t index) const {
    if (auto p = std::get_if<Array>(&data_)) {
        if (index < p->size()) return (*p)[index];
    }
    return kNullValue;
}

static void EscapeString(const std::string& in, std::string& out) {
    out += '"';
    for (unsigned char c : in) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b"; break;
            case '\f': out += "\\f"; break;
            case '\n': out += "\\n"; break;
            case '\r': out += "\\r"; break;
            case '\t': out += "\\t"; break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += static_cast<char>(c);
                }
                break;
        }
    }
    out += '"';
}

std::string Value::Dump(int indent) const {
    std::string res;
    switch (GetType()) {
        case Type::Null: res = "null"; break;
        case Type::Boolean: res = AsBool() ? "true" : "false"; break;
        case Type::Number: {
            double d = AsDouble();
            if (std::floor(d) == d && !std::isinf(d) && std::abs(d) < 9e15) {
                res = std::to_string(static_cast<int64_t>(d));
            } else {
                std::ostringstream ss;
                ss << d;
                res = ss.str();
            }
            break;
        }
        case Type::String: EscapeString(AsString(), res); break;
        case Type::Array: {
            const auto& arr = AsArray();
            res += "[";
            for (size_t i = 0; i < arr.size(); ++i) {
                if (i > 0) res += ",";
                res += arr[i].Dump(indent);
            }
            res += "]";
            break;
        }
        case Type::Object: {
            const auto& obj = AsObject();
            res += "{";
            bool first = true;
            for (const auto& [k, v] : obj) {
                if (!first) res += ",";
                first = false;
                std::string ek;
                EscapeString(k, ek);
                res += ek + ":" + v.Dump(indent);
            }
            res += "}";
            break;
        }
    }
    return res;
}

// ============================================================================
// Проверка UTF-8 и отсутствия BOM
// ============================================================================

bool Parser::ValidateUtf8NoBom(const std::string& text, std::string& out_error) {
    if (text.size() >= 3) {
        const auto* b = reinterpret_cast<const uint8_t*>(text.data());
        if (b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) {
            out_error = "UTF-8 BOM detected: contract strictly requires UTF-8 without BOM";
            return false;
        }
    }

    const auto* p = reinterpret_cast<const uint8_t*>(text.data());
    size_t len = text.size();
    size_t i = 0;

    while (i < len) {
        uint8_t c = p[i];
        if (c <= 0x7F) {
            i++;
        } else if ((c & 0xE0) == 0xC0) {
            if (i + 1 >= len) { out_error = "Truncated 2-byte UTF-8 sequence"; return false; }
            if ((p[i+1] & 0xC0) != 0x80) { out_error = "Invalid UTF-8 continuation byte"; return false; }
            if (c < 0xC2) { out_error = "Overlong 2-byte UTF-8 sequence"; return false; }
            i += 2;
        } else if ((c & 0xF0) == 0xE0) {
            if (i + 2 >= len) { out_error = "Truncated 3-byte UTF-8 sequence"; return false; }
            if ((p[i+1] & 0xC0) != 0x80 || (p[i+2] & 0xC0) != 0x80) { out_error = "Invalid UTF-8 continuation byte"; return false; }
            if (c == 0xE0 && p[i+1] < 0xA0) { out_error = "Overlong 3-byte UTF-8 sequence"; return false; }
            if (c == 0xED && p[i+1] >= 0xA0) { out_error = "UTF-8 surrogate half prohibited"; return false; }
            i += 3;
        } else if ((c & 0xF8) == 0xF0) {
            if (i + 3 >= len) { out_error = "Truncated 4-byte UTF-8 sequence"; return false; }
            if ((p[i+1] & 0xC0) != 0x80 || (p[i+2] & 0xC0) != 0x80 || (p[i+3] & 0xC0) != 0x80) {
                out_error = "Invalid UTF-8 continuation byte"; return false;
            }
            if (c == 0xF0 && p[i+1] < 0x90) { out_error = "Overlong 4-byte UTF-8 sequence"; return false; }
            if (c > 0xF4 || (c == 0xF4 && p[i+1] > 0x8F)) { out_error = "UTF-8 code point out of range (> U+10FFFF)"; return false; }
            i += 4;
        } else {
            out_error = "Invalid leading UTF-8 byte 0x" + std::to_string(static_cast<int>(c));
            return false;
        }
    }
    return true;
}

// ============================================================================
// Реализация Parser
// ============================================================================

bool Parser::Parse(const std::string& json_text, Value& out_value, std::string& out_error) {
    if (!ValidateUtf8NoBom(json_text, out_error)) {
        return false;
    }

    Parser p(json_text);
    p.SkipWhitespace();
    if (p.Eof()) {
        out_error = "Empty JSON input";
        return false;
    }

    if (!p.ParseValue(out_value)) {
        out_error = p.error_;
        return false;
    }

    p.SkipWhitespace();
    if (!p.Eof()) {
        out_error = "Unexpected trailing characters after JSON root at position " + std::to_string(p.pos_);
        return false;
    }

    return true;
}

void Parser::SkipWhitespace() {
    while (pos_ < text_.size()) {
        char c = text_[pos_];
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
            pos_++;
        } else {
            break;
        }
    }
}

char Parser::Peek() const {
    if (pos_ < text_.size()) return text_[pos_];
    return '\0';
}

char Parser::Get() {
    if (pos_ < text_.size()) return text_[pos_++];
    return '\0';
}

bool Parser::Eof() const {
    return pos_ >= text_.size();
}

void Parser::SetError(const std::string& msg) {
    if (error_.empty()) {
        error_ = msg + " at character " + std::to_string(pos_);
    }
}

bool Parser::ParseValue(Value& val) {
    SkipWhitespace();
    char c = Peek();
    if (c == '{') return ParseObject(val);
    if (c == '[') return ParseArray(val);
    if (c == '"') {
        std::string s;
        if (!ParseString(s)) return false;
        val = Value(std::move(s));
        return true;
    }
    if (c == 't') return ParseLiteral("true", val);
    if (c == 'f') return ParseLiteral("false", val);
    if (c == 'n') return ParseLiteral("null", val);
    if (c == '-' || (c >= '0' && c <= '9')) return ParseNumber(val);

    SetError(std::string("Unexpected character '") + c + "'");
    return false;
}

bool Parser::ParseLiteral(const std::string& lit, Value& val) {
    for (char expected : lit) {
        if (Get() != expected) {
            SetError("Expected literal '" + lit + "'");
            return false;
        }
    }
    if (lit == "true") val = Value(true);
    else if (lit == "false") val = Value(false);
    else if (lit == "null") val = Value(nullptr);
    return true;
}

bool Parser::ParseString(std::string& str) {
    if (Get() != '"') {
        SetError("Expected '\"'");
        return false;
    }

    str.clear();
    while (!Eof()) {
        char c = Get();
        if (c == '"') {
            return true;
        }
        if (static_cast<unsigned char>(c) < 0x20) {
            SetError("Unescaped control character in string");
            return false;
        }
        if (c == '\\') {
            if (Eof()) { SetError("Unterminated escape sequence"); return false; }
            char esc = Get();
            switch (esc) {
                case '"':  str += '"'; break;
                case '\\': str += '\\'; break;
                case '/':  str += '/'; break;
                case 'b':  str += '\b'; break;
                case 'f':  str += '\f'; break;
                case 'n':  str += '\n'; break;
                case 'r':  str += '\r'; break;
                case 't':  str += '\t'; break;
                case 'u': {
                    uint32_t codepoint = 0;
                    for (int k = 0; k < 4; ++k) {
                        if (Eof()) { SetError("Incomplete unicode escape"); return false; }
                        char h = Get();
                        codepoint <<= 4;
                        if (h >= '0' && h <= '9') codepoint |= (h - '0');
                        else if (h >= 'a' && h <= 'f') codepoint |= (h - 'a' + 10);
                        else if (h >= 'A' && h <= 'F') codepoint |= (h - 'A' + 10);
                        else { SetError("Invalid hex in unicode escape"); return false; }
                    }
                    // Handle UTF-16 surrogate pairs
                    if (codepoint >= 0xD800 && codepoint <= 0xDBFF) {
                        if (Peek() == '\\') {
                            size_t saved = pos_;
                            Get(); // '\\'
                            if (Peek() == 'u') {
                                Get(); // 'u'
                                uint32_t low = 0;
                                bool ok = true;
                                for (int k = 0; k < 4; ++k) {
                                    if (Eof()) { ok = false; break; }
                                    char h = Get();
                                    low <<= 4;
                                    if (h >= '0' && h <= '9') low |= (h - '0');
                                    else if (h >= 'a' && h <= 'f') low |= (h - 'a' + 10);
                                    else if (h >= 'A' && h <= 'F') low |= (h - 'A' + 10);
                                    else { ok = false; break; }
                                }
                                if (ok && low >= 0xDC00 && low <= 0xDFFF) {
                                    codepoint = 0x10000 + (((codepoint & 0x3FF) << 10) | (low & 0x3FF));
                                } else {
                                    pos_ = saved; // rollback
                                }
                            } else {
                                pos_ = saved;
                            }
                        }
                    }

                    // Encode codepoint to UTF-8
                    if (codepoint <= 0x7F) {
                        str += static_cast<char>(codepoint);
                    } else if (codepoint <= 0x7FF) {
                        str += static_cast<char>(0xC0 | ((codepoint >> 6) & 0x1F));
                        str += static_cast<char>(0x80 | (codepoint & 0x3F));
                    } else if (codepoint <= 0xFFFF) {
                        str += static_cast<char>(0xE0 | ((codepoint >> 12) & 0x0F));
                        str += static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F));
                        str += static_cast<char>(0x80 | (codepoint & 0x3F));
                    } else {
                        str += static_cast<char>(0xF0 | ((codepoint >> 18) & 0x07));
                        str += static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F));
                        str += static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F));
                        str += static_cast<char>(0x80 | (codepoint & 0x3F));
                    }
                    break;
                }
                default:
                    SetError(std::string("Unknown escape sequence '\\") + esc + "'");
                    return false;
            }
        } else {
            str += c;
        }
    }

    SetError("Unterminated string");
    return false;
}

bool Parser::ParseNumber(Value& val) {
    size_t start = pos_;
    if (Peek() == '-') Get();

    if (Eof()) { SetError("Invalid number"); return false; }

    char c = Get();
    if (c == '0') {
        if (Peek() >= '0' && Peek() <= '9') {
            SetError("Leading zeros not allowed in numbers");
            return false;
        }
    } else if (c >= '1' && c <= '9') {
        while (Peek() >= '0' && Peek() <= '9') Get();
    } else {
        SetError("Invalid number format");
        return false;
    }

    if (Peek() == '.') {
        Get();
        if (Peek() < '0' || Peek() > '9') {
            SetError("Decimal point must be followed by digits");
            return false;
        }
        while (Peek() >= '0' && Peek() <= '9') Get();
    }

    if (Peek() == 'e' || Peek() == 'E') {
        Get();
        if (Peek() == '+' || Peek() == '-') Get();
        if (Peek() < '0' || Peek() > '9') {
            SetError("Exponent must be followed by digits");
            return false;
        }
        while (Peek() >= '0' && Peek() <= '9') Get();
    }

    std::string_view num_str = text_.substr(start, pos_ - start);
    try {
        double d = std::stod(std::string(num_str));
        val = Value(d);
        return true;
    } catch (...) {
        SetError("Numeric overflow or invalid double");
        return false;
    }
}

bool Parser::ParseArray(Value& val) {
    if (Get() != '[') { SetError("Expected '['"); return false; }
    Array arr;
    SkipWhitespace();
    if (Peek() == ']') {
        Get();
        val = Value(std::move(arr));
        return true;
    }

    while (true) {
        Value elem;
        if (!ParseValue(elem)) return false;
        arr.push_back(std::move(elem));
        SkipWhitespace();
        char c = Peek();
        if (c == ']') {
            Get();
            break;
        }
        if (c == ',') {
            Get();
            SkipWhitespace();
            if (Peek() == ']') {
                SetError("Trailing comma in array");
                return false;
            }
        } else {
            SetError("Expected ',' or ']' in array");
            return false;
        }
    }

    val = Value(std::move(arr));
    return true;
}

bool Parser::ParseObject(Value& val) {
    if (Get() != '{') { SetError("Expected '{'"); return false; }
    Object obj;
    SkipWhitespace();
    if (Peek() == '}') {
        Get();
        val = Value(std::move(obj));
        return true;
    }

    while (true) {
        SkipWhitespace();
        if (Peek() != '"') {
            SetError("Expected string key in object");
            return false;
        }
        std::string key;
        if (!ParseString(key)) return false;

        SkipWhitespace();
        if (Get() != ':') {
            SetError("Expected ':' after object key");
            return false;
        }

        Value member;
        if (!ParseValue(member)) return false;
        obj[key] = std::move(member);

        SkipWhitespace();
        char c = Peek();
        if (c == '}') {
            Get();
            break;
        }
        if (c == ',') {
            Get();
            SkipWhitespace();
            if (Peek() == '}') {
                SetError("Trailing comma in object");
                return false;
            }
        } else {
            SetError("Expected ',' or '}' in object");
            return false;
        }
    }

    val = Value(std::move(obj));
    return true;
}

// ============================================================================
// Валидация Spool Envelope v1.0
// ============================================================================

bool Parser::ParseSpoolEnvelope(const std::string& json_text, SpoolEnvelope& out, std::string& out_error) {
    if (json_text.size() > MAX_PAYLOAD_BYTES) {
        out_error = "Payload exceeds maximum allowed size 65536 bytes (actual: " + 
                    std::to_string(json_text.size()) + " bytes)";
        return false;
    }

    Value root;
    if (!Parse(json_text, root, out_error)) {
        return false;
    }

    if (!root.IsObject()) {
        out_error = "Root JSON element must be an Object";
        return false;
    }

    // 1. schema_version
    const auto* sv = root.Find("schema_version");
    if (!sv || !sv->IsString()) {
        out_error = "Missing or invalid 'schema_version' (must be String)";
        return false;
    }
    if (sv->AsString() != SCHEMA_VERSION_1_0) {
        out_error = "Unsupported schema_version: expected '" + std::string(SCHEMA_VERSION_1_0) + 
                    "', got '" + sv->AsString() + "'";
        return false;
    }
    out.schema_version = sv->AsString();

    // 2. event_id (GUID check)
    const auto* eid = root.Find("event_id");
    if (!eid || !eid->IsString() || eid->AsString().empty()) {
        out_error = "Missing or empty 'event_id'";
        return false;
    }
    const std::string& guid_str = eid->AsString();
    if (guid_str.size() != 36 || guid_str[8] != '-' || guid_str[13] != '-' || 
        guid_str[18] != '-' || guid_str[23] != '-') {
        out_error = "Invalid GUID format for 'event_id': " + guid_str;
        return false;
    }
    out.event_id = guid_str;

    // 3. timestamp_utc
    const auto* ts = root.Find("timestamp_utc");
    if (!ts || !ts->IsString() || ts->AsString().empty()) {
        out_error = "Missing or empty 'timestamp_utc'";
        return false;
    }
    out.timestamp_utc = ts->AsString();

    // 4. source
    const auto* src = root.Find("source");
    if (!src || !src->IsString() || src->AsString() != SOURCE_1C_EXTENSION) {
        out_error = "Invalid 'source': expected '" + std::string(SOURCE_1C_EXTENSION) + "'";
        return false;
    }
    out.source = src->AsString();

    // 5. event_type
    const auto* et = root.Find("event_type");
    if (!et || !et->IsString()) {
        out_error = "Missing or invalid 'event_type'";
        return false;
    }
    EventType type = EventTypeFromString(et->AsString());
    if (type == EventType::UNKNOWN) {
        out_error = "Unknown 'event_type': " + et->AsString();
        return false;
    }
    out.event_type = et->AsString();

    // 6. priority
    const auto* pr = root.Find("priority");
    if (!pr || !pr->IsString()) {
        out_error = "Missing or invalid 'priority'";
        return false;
    }
    std::string pstr = pr->AsString();
    if (pstr != "NORMAL" && pstr != "HIGH" && pstr != "LOW") {
        out_error = "Invalid 'priority': " + pstr + " (expected NORMAL, HIGH, LOW)";
        return false;
    }
    out.priority = pstr;

    // 7. payload
    const auto* pl = root.Find("payload");
    if (!pl || !pl->IsObject()) {
        out_error = "Missing or invalid 'payload' (must be Object)";
        return false;
    }

    // payload.shop
    const auto* shop = pl->Find("shop");
    if (!shop || !shop->IsString() || shop->AsString().empty()) {
        out_error = "Missing or empty required field 'payload.shop'";
        return false;
    }
    out.shop = shop->AsString();

    // payload.workplace
    const auto* wp = pl->Find("workplace");
    if (!wp || !wp->IsString() || wp->AsString().empty()) {
        out_error = "Missing or empty required field 'payload.workplace'";
        return false;
    }
    out.workplace = wp->AsString();

    // payload.warnings
    out.warnings.clear();
    if (const auto* w = pl->Find("warnings")) {
        if (w->IsArray()) {
            for (const auto& item : w->AsArray()) {
                if (item.IsString()) {
                    out.warnings.push_back(item.AsString());
                }
            }
        }
    }

    // payload.runtime_errors (dumped as raw JSON for DB/API)
    if (const auto* re = pl->Find("runtime_errors")) {
        out.runtime_errors_raw_json = re->Dump();
    } else {
        out.runtime_errors_raw_json = "[]";
    }

    // payload.health_checks (dumped as raw JSON)
    if (const auto* hc = pl->Find("health_checks")) {
        out.health_checks_raw_json = hc->Dump();
    } else {
        out.health_checks_raw_json = "[]";
    }

    // payload.one_c_info
    if (const auto* oci = pl->Find("one_c_info")) {
        if (oci->IsObject()) {
            if (const auto* pv = oci->Find("platform_version")) out.one_c_info.platform_version = pv->AsString();
            if (const auto* cn = oci->Find("configuration_name")) out.one_c_info.configuration_name = cn->AsString();
            if (const auto* cmn = oci->Find("computer_name")) out.one_c_info.computer_name = cmn->AsString();
        }
    }

    out.raw_json = json_text;
    return true;
}

} // namespace noc::json
