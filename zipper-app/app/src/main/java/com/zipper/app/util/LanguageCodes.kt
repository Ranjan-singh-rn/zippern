package com.zipper.app.util

data class AppLanguage(
    val id: Int,
    val code: String,       // ISO 639-1 (or BCP-47 for variants)
    val name: String,       // English name
    val nativeName: String, // Name in the language itself
)

/** Firestore-serialisable form — no enum, no object reference, just plain data. */
data class UserLanguage(
    val id: Int = 0,
    val code: String = "",
    val name: String = "",
)

fun AppLanguage.toUserLanguage() = UserLanguage(id = id, code = code, name = name)

val ALL_LANGUAGES: List<AppLanguage> = listOf(
    // ── South Asian ──────────────────────────────────────────────────────────
    AppLanguage(1,  "en",    "English",            "English"),
    AppLanguage(2,  "hi",    "Hindi",              "हिन्दी"),
    AppLanguage(3,  "bn",    "Bengali",            "বাংলা"),
    AppLanguage(4,  "or",    "Odia",               "ଓଡ଼ିଆ"),
    AppLanguage(5,  "te",    "Telugu",             "తెలుగు"),
    AppLanguage(6,  "ta",    "Tamil",              "தமிழ்"),
    AppLanguage(7,  "kn",    "Kannada",            "ಕನ್ನಡ"),
    AppLanguage(8,  "ml",    "Malayalam",          "മലയാളം"),
    AppLanguage(9,  "pa",    "Punjabi",            "ਪੰਜਾਬੀ"),
    AppLanguage(10, "gu",    "Gujarati",           "ગુજરાતી"),
    AppLanguage(11, "mr",    "Marathi",            "मराठी"),
    AppLanguage(12, "ur",    "Urdu",               "اردو"),
    AppLanguage(13, "ne",    "Nepali",             "नेपाली"),
    AppLanguage(14, "si",    "Sinhala",            "සිංහල"),
    AppLanguage(15, "my",    "Burmese",            "မြန်မာဘာသာ"),

    // ── European — Romance ───────────────────────────────────────────────────
    AppLanguage(20, "es",    "Spanish",            "Español"),
    AppLanguage(21, "pt",    "Portuguese",         "Português"),
    AppLanguage(22, "fr",    "French",             "Français"),
    AppLanguage(23, "it",    "Italian",            "Italiano"),
    AppLanguage(24, "ro",    "Romanian",           "Română"),
    AppLanguage(25, "ca",    "Catalan",            "Català"),

    // ── European — Germanic ──────────────────────────────────────────────────
    AppLanguage(30, "de",    "German",             "Deutsch"),
    AppLanguage(31, "nl",    "Dutch",              "Nederlands"),
    AppLanguage(32, "sv",    "Swedish",            "Svenska"),
    AppLanguage(33, "no",    "Norwegian",          "Norsk"),
    AppLanguage(34, "da",    "Danish",             "Dansk"),
    AppLanguage(35, "fi",    "Finnish",            "Suomi"),
    AppLanguage(36, "af",    "Afrikaans",          "Afrikaans"),

    // ── European — Slavic ────────────────────────────────────────────────────
    AppLanguage(40, "ru",    "Russian",            "Русский"),
    AppLanguage(41, "uk",    "Ukrainian",          "Українська"),
    AppLanguage(42, "pl",    "Polish",             "Polski"),
    AppLanguage(43, "cs",    "Czech",              "Čeština"),
    AppLanguage(44, "sk",    "Slovak",             "Slovenčina"),
    AppLanguage(45, "bg",    "Bulgarian",          "Български"),
    AppLanguage(46, "hr",    "Croatian",           "Hrvatski"),
    AppLanguage(47, "sr",    "Serbian",            "Српски"),
    AppLanguage(48, "sl",    "Slovenian",          "Slovenščina"),
    AppLanguage(49, "bs",    "Bosnian",            "Bosanski"),
    AppLanguage(50, "mk",    "Macedonian",         "Македонски"),
    AppLanguage(51, "be",    "Belarusian",         "Беларуская"),

    // ── European — Baltic & Other ────────────────────────────────────────────
    AppLanguage(55, "lt",    "Lithuanian",         "Lietuvių"),
    AppLanguage(56, "lv",    "Latvian",            "Latviešu"),
    AppLanguage(57, "et",    "Estonian",           "Eesti"),
    AppLanguage(58, "el",    "Greek",              "Ελληνικά"),
    AppLanguage(59, "hu",    "Hungarian",          "Magyar"),
    AppLanguage(60, "tr",    "Turkish",            "Türkçe"),
    AppLanguage(61, "sq",    "Albanian",           "Shqip"),

    // ── Middle East & Central Asia ───────────────────────────────────────────
    AppLanguage(70, "ar",    "Arabic",             "العربية"),
    AppLanguage(71, "fa",    "Persian",            "فارسی"),
    AppLanguage(72, "he",    "Hebrew",             "עברית"),
    AppLanguage(73, "ku",    "Kurdish",            "Kurdî"),
    AppLanguage(74, "az",    "Azerbaijani",        "Azərbaycan"),
    AppLanguage(75, "hy",    "Armenian",           "Հայերեն"),
    AppLanguage(76, "ka",    "Georgian",           "ქართული"),
    AppLanguage(77, "kk",    "Kazakh",             "Қазақша"),
    AppLanguage(78, "uz",    "Uzbek",              "O'zbek"),
    AppLanguage(79, "tk",    "Turkmen",            "Türkmen"),
    AppLanguage(80, "ky",    "Kyrgyz",             "Кыргызча"),
    AppLanguage(81, "tg",    "Tajik",              "Тоҷикӣ"),

    // ── East Asian ───────────────────────────────────────────────────────────
    AppLanguage(90, "zh-CN", "Chinese (Simplified)",  "中文（简体）"),
    AppLanguage(91, "zh-TW", "Chinese (Traditional)", "中文（繁體）"),
    AppLanguage(92, "ja",    "Japanese",           "日本語"),
    AppLanguage(93, "ko",    "Korean",             "한국어"),
    AppLanguage(94, "mn",    "Mongolian",          "Монгол"),

    // ── Southeast Asian ──────────────────────────────────────────────────────
    AppLanguage(100, "th",   "Thai",               "ไทย"),
    AppLanguage(101, "vi",   "Vietnamese",         "Tiếng Việt"),
    AppLanguage(102, "id",   "Indonesian",         "Bahasa Indonesia"),
    AppLanguage(103, "ms",   "Malay",              "Bahasa Melayu"),
    AppLanguage(104, "tl",   "Filipino",           "Filipino"),
    AppLanguage(105, "km",   "Khmer",              "ខ្មែរ"),
    AppLanguage(106, "lo",   "Lao",                "ລາວ"),
    AppLanguage(107, "jv",   "Javanese",           "Basa Jawa"),
    AppLanguage(108, "su",   "Sundanese",          "Basa Sunda"),

    // ── African ──────────────────────────────────────────────────────────────
    AppLanguage(120, "sw",   "Swahili",            "Kiswahili"),
    AppLanguage(121, "zu",   "Zulu",               "isiZulu"),
    AppLanguage(122, "am",   "Amharic",            "አማርኛ"),
    AppLanguage(123, "ha",   "Hausa",              "Hausa"),
    AppLanguage(124, "yo",   "Yoruba",             "Yorùbá"),
    AppLanguage(125, "ig",   "Igbo",               "Igbo"),
    AppLanguage(126, "xh",   "Xhosa",              "isiXhosa"),
    AppLanguage(127, "so",   "Somali",             "Soomaali"),
    AppLanguage(128, "rw",   "Kinyarwanda",        "Kinyarwanda"),
    AppLanguage(129, "mg",   "Malagasy",           "Malagasy"),

    // ── Americas ─────────────────────────────────────────────────────────────
    AppLanguage(140, "qu",   "Quechua",            "Runa Simi"),
    AppLanguage(141, "gn",   "Guaraní",            "Avañe'ẽ"),
).sortedBy { it.name }

/** Look up AppLanguage by ISO code (case-insensitive). */
fun languageByCode(code: String): AppLanguage? =
    ALL_LANGUAGES.firstOrNull { it.code.equals(code, ignoreCase = true) }

/** ISO codes that are RTL — used to set layoutDirection on chips. */
val RTL_LANGUAGE_CODES = setOf("ar", "fa", "he", "ur", "ku")
