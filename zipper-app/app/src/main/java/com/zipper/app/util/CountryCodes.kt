package com.zipper.app.util

data class CountryCode(
    val name: String,
    val flag: String,
    val dialCode: String,
    val maxDigits: Int = 12,   // max local number length (digits after dial code)
)

val ALL_COUNTRIES = listOf(
    CountryCode("Afghanistan",          "🇦🇫", "+93",  9),
    CountryCode("Albania",              "🇦🇱", "+355", 9),
    CountryCode("Algeria",              "🇩🇿", "+213", 9),
    CountryCode("Argentina",            "🇦🇷", "+54",  10),
    CountryCode("Armenia",              "🇦🇲", "+374", 8),
    CountryCode("Australia",            "🇦🇺", "+61",  9),
    CountryCode("Austria",              "🇦🇹", "+43",  10),
    CountryCode("Azerbaijan",           "🇦🇿", "+994", 9),
    CountryCode("Bahrain",              "🇧🇭", "+973", 8),
    CountryCode("Bangladesh",           "🇧🇩", "+880", 10),
    CountryCode("Belarus",              "🇧🇾", "+375", 9),
    CountryCode("Belgium",              "🇧🇪", "+32",  9),
    CountryCode("Bolivia",              "🇧🇴", "+591", 8),
    CountryCode("Bosnia & Herzegovina", "🇧🇦", "+387", 8),
    CountryCode("Brazil",               "🇧🇷", "+55",  11),
    CountryCode("Bulgaria",             "🇧🇬", "+359", 9),
    CountryCode("Cambodia",             "🇰🇭", "+855", 9),
    CountryCode("Cameroon",             "🇨🇲", "+237", 9),
    CountryCode("Canada",               "🇨🇦", "+1",   10),
    CountryCode("Chile",                "🇨🇱", "+56",  9),
    CountryCode("China",                "🇨🇳", "+86",  11),
    CountryCode("Colombia",             "🇨🇴", "+57",  10),
    CountryCode("Croatia",              "🇭🇷", "+385", 9),
    CountryCode("Cyprus",               "🇨🇾", "+357", 8),
    CountryCode("Czech Republic",       "🇨🇿", "+420", 9),
    CountryCode("Denmark",              "🇩🇰", "+45",  8),
    CountryCode("Ecuador",              "🇪🇨", "+593", 9),
    CountryCode("Egypt",                "🇪🇬", "+20",  10),
    CountryCode("Estonia",              "🇪🇪", "+372", 8),
    CountryCode("Ethiopia",             "🇪🇹", "+251", 9),
    CountryCode("Finland",              "🇫🇮", "+358", 10),
    CountryCode("France",               "🇫🇷", "+33",  9),
    CountryCode("Georgia",              "🇬🇪", "+995", 9),
    CountryCode("Germany",              "🇩🇪", "+49",  11),
    CountryCode("Ghana",                "🇬🇭", "+233", 9),
    CountryCode("Greece",               "🇬🇷", "+30",  10),
    CountryCode("Guatemala",            "🇬🇹", "+502", 8),
    CountryCode("Hong Kong",            "🇭🇰", "+852", 8),
    CountryCode("Hungary",              "🇭🇺", "+36",  9),
    CountryCode("India",                "🇮🇳", "+91",  10),
    CountryCode("Indonesia",            "🇮🇩", "+62",  12),
    CountryCode("Iran",                 "🇮🇷", "+98",  10),
    CountryCode("Iraq",                 "🇮🇶", "+964", 10),
    CountryCode("Ireland",              "🇮🇪", "+353", 9),
    CountryCode("Israel",               "🇮🇱", "+972", 9),
    CountryCode("Italy",                "🇮🇹", "+39",  10),
    CountryCode("Jamaica",              "🇯🇲", "+1",   10),
    CountryCode("Japan",                "🇯🇵", "+81",  10),
    CountryCode("Jordan",               "🇯🇴", "+962", 9),
    CountryCode("Kazakhstan",           "🇰🇿", "+7",   10),
    CountryCode("Kenya",                "🇰🇪", "+254", 9),
    CountryCode("Kuwait",               "🇰🇼", "+965", 8),
    CountryCode("Kyrgyzstan",           "🇰🇬", "+996", 9),
    CountryCode("Laos",                 "🇱🇦", "+856", 9),
    CountryCode("Latvia",               "🇱🇻", "+371", 8),
    CountryCode("Lebanon",              "🇱🇧", "+961", 8),
    CountryCode("Libya",                "🇱🇾", "+218", 9),
    CountryCode("Lithuania",            "🇱🇹", "+370", 8),
    CountryCode("Luxembourg",           "🇱🇺", "+352", 9),
    CountryCode("Malaysia",             "🇲🇾", "+60",  10),
    CountryCode("Maldives",             "🇲🇻", "+960", 7),
    CountryCode("Mexico",               "🇲🇽", "+52",  10),
    CountryCode("Moldova",              "🇲🇩", "+373", 8),
    CountryCode("Mongolia",             "🇲🇳", "+976", 8),
    CountryCode("Morocco",              "🇲🇦", "+212", 9),
    CountryCode("Mozambique",           "🇲🇿", "+258", 9),
    CountryCode("Myanmar",              "🇲🇲", "+95",  9),
    CountryCode("Nepal",                "🇳🇵", "+977", 10),
    CountryCode("Netherlands",          "🇳🇱", "+31",  9),
    CountryCode("New Zealand",          "🇳🇿", "+64",  9),
    CountryCode("Nigeria",              "🇳🇬", "+234", 10),
    CountryCode("Norway",               "🇳🇴", "+47",  8),
    CountryCode("Oman",                 "🇴🇲", "+968", 8),
    CountryCode("Pakistan",             "🇵🇰", "+92",  10),
    CountryCode("Palestine",            "🇵🇸", "+970", 9),
    CountryCode("Panama",               "🇵🇦", "+507", 8),
    CountryCode("Paraguay",             "🇵🇾", "+595", 9),
    CountryCode("Peru",                 "🇵🇪", "+51",  9),
    CountryCode("Philippines",          "🇵🇭", "+63",  10),
    CountryCode("Poland",               "🇵🇱", "+48",  9),
    CountryCode("Portugal",             "🇵🇹", "+351", 9),
    CountryCode("Qatar",                "🇶🇦", "+974", 8),
    CountryCode("Romania",              "🇷🇴", "+40",  9),
    CountryCode("Russia",               "🇷🇺", "+7",   10),
    CountryCode("Saudi Arabia",         "🇸🇦", "+966", 9),
    CountryCode("Serbia",               "🇷🇸", "+381", 9),
    CountryCode("Singapore",            "🇸🇬", "+65",  8),
    CountryCode("Slovakia",             "🇸🇰", "+421", 9),
    CountryCode("Slovenia",             "🇸🇮", "+386", 8),
    CountryCode("South Africa",         "🇿🇦", "+27",  9),
    CountryCode("South Korea",          "🇰🇷", "+82",  10),
    CountryCode("Spain",                "🇪🇸", "+34",  9),
    CountryCode("Sri Lanka",            "🇱🇰", "+94",  9),
    CountryCode("Sudan",                "🇸🇩", "+249", 9),
    CountryCode("Sweden",               "🇸🇪", "+46",  9),
    CountryCode("Switzerland",          "🇨🇭", "+41",  9),
    CountryCode("Syria",                "🇸🇾", "+963", 9),
    CountryCode("Taiwan",               "🇹🇼", "+886", 9),
    CountryCode("Tajikistan",           "🇹🇯", "+992", 9),
    CountryCode("Tanzania",             "🇹🇿", "+255", 9),
    CountryCode("Thailand",             "🇹🇭", "+66",  9),
    CountryCode("Tunisia",              "🇹🇳", "+216", 8),
    CountryCode("Turkey",               "🇹🇷", "+90",  10),
    CountryCode("Turkmenistan",         "🇹🇲", "+993", 8),
    CountryCode("Uganda",               "🇺🇬", "+256", 9),
    CountryCode("Ukraine",              "🇺🇦", "+380", 9),
    CountryCode("United Arab Emirates", "🇦🇪", "+971", 9),
    CountryCode("United Kingdom",       "🇬🇧", "+44",  10),
    CountryCode("United States",        "🇺🇸", "+1",   10),
    CountryCode("Uruguay",              "🇺🇾", "+598", 8),
    CountryCode("Uzbekistan",           "🇺🇿", "+998", 9),
    CountryCode("Venezuela",            "🇻🇪", "+58",  10),
    CountryCode("Vietnam",              "🇻🇳", "+84",  9),
    CountryCode("Yemen",                "🇾🇪", "+967", 9),
    CountryCode("Zimbabwe",             "🇿🇼", "+263", 9),
).sortedBy { it.name }

/**
 * QA #7: the picker's list — India pinned first (nearly every Zipper user dials +91), the rest in the list's order.
 * A search keeps the same rule: India first when it matches.
 */
fun countriesForPicker(query: String = "", all: List<CountryCode> = ALL_COUNTRIES): List<CountryCode> {
    val q = query.trim()
    val matched = if (q.isEmpty()) all else all.filter { it.name.contains(q, ignoreCase = true) || it.dialCode.contains(q) }
    val india = matched.filter { it.dialCode == "+91" }
    return india + matched.filterNot { it.dialCode == "+91" }
}

/**
 * QA #8: what is wrong with a phone number as typed, in words a person can act on — or null when it can be sent.
 *
 * [digits] is the local part only (the field already strips anything but digits and caps it at [CountryCode.maxDigits]).
 * India is checked exactly (10 digits, starting 6–9: every Indian mobile number); elsewhere only the length, since
 * numbering plans differ and the SMS provider is the real judge.
 */
fun phoneNumberProblem(digits: String, country: CountryCode): String? {
    if (digits.isEmpty()) return "Enter your mobile number."
    if (country.dialCode == "+91") {
        if (digits.first() !in '6'..'9') return "Indian mobile numbers start with 6, 7, 8 or 9."
        if (digits.length != 10) return "Indian mobile numbers have 10 digits."
        return null
    }
    if (digits.length < 5) return "That number looks too short."
    return null
}

/**
 * Whether to SHOW [phoneNumberProblem] yet: not while somebody is still typing a number that could become right —
 * a wrong first digit shows at once, a short number only once the field is full or the person tries to send it.
 */
fun showPhoneProblemNow(digits: String, country: CountryCode, submitted: Boolean): Boolean {
    if (digits.isEmpty()) return submitted
    if (country.dialCode == "+91" && digits.first() !in '6'..'9') return true
    return submitted || digits.length >= country.maxDigits
}
