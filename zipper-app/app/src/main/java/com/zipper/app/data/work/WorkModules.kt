package com.zipper.app.data.work

/**
 * Every work screen the app offers, in hub order. The parity matrix
 * (outputs/parity-audit/B3-PARITY-MATRIX-*.md) is generated from `crm` on each
 * module, so a CRM page with no module is visible there as a gap.
 */
object WorkModules {

    val all: List<WorkModule> by lazy {
        partnerModules + sessionModules + queueModules + peopleModules + partnersModules + moneyModules +
            reportModules + opsModules + chanceModules
    }

    fun byId(id: String): WorkModule? = all.firstOrNull { it.id == id }

    /** What this session is offered, grouped in hub order. */
    fun offered(caps: Caps): List<Pair<Group, List<WorkModule>>> =
        Group.values().mapNotNull { g ->
            val mods = all.filter { it.group == g && it.gate(caps) }
            if (mods.isEmpty()) null else g to mods
        }
}
