package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

/**
 * UGP D21 — the guard on a same-uid session token: the app continues its session
 * from a server-minted custom token only when the token is for the uid already
 * signed in. This pins the claim reader the guard depends on.
 */
class CustomTokensTest {

    private fun jwt(payload: String): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        val header = enc.encodeToString("{\"alg\":\"RS256\",\"typ\":\"JWT\"}".toByteArray())
        val body = enc.encodeToString(payload.toByteArray())
        return "$header.$body.signature"
    }

    @Test fun `reads the uid claim of an Admin SDK custom token`() {
        val t = jwt("{\"aud\":\"https://identitytoolkit.googleapis.com/\",\"iat\":1,\"exp\":2,\"uid\":\"G1abc\"}")
        assertEquals("G1abc", CustomTokens.uidOf(t))
    }

    @Test fun `anything that is not a readable token yields no uid`() {
        assertEquals("", CustomTokens.uidOf(""))
        assertEquals("", CustomTokens.uidOf("not-a-token"))
        assertEquals("", CustomTokens.uidOf("a.%%%.c"))
        assertEquals("", CustomTokens.uidOf(jwt("{\"sub\":\"x\"}")))
    }

    // QA #30: after an e-mail bind EVERY session (phone too) is handed a same-uid
    // token. The device continues only as the account already signed in.
    @Test fun `a phone session adopts the same-uid token handed back after an email bind`() {
        val t = jwt("{\"uid\":\"PH1\",\"iat\":1,\"exp\":2}")
        assertEquals(true, CustomTokens.adoptable(t, "PH1"))
    }

    @Test fun `a token for any other account is never adopted`() {
        val t = jwt("{\"uid\":\"VICTIM\",\"iat\":1,\"exp\":2}")
        assertEquals(false, CustomTokens.adoptable(t, "PH1"))
        assertEquals(false, CustomTokens.adoptable(t, null))
        assertEquals(false, CustomTokens.adoptable(t, ""))
        assertEquals(false, CustomTokens.adoptable("garbage", "PH1"))
        assertEquals(false, CustomTokens.adoptable(jwt("{\"uid\":\"\"}"), ""))
    }
}
