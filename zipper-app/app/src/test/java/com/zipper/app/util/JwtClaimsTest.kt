package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Base64

class JwtClaimsTest {
    private fun jwt(payload: String): String {
        val enc = Base64.getUrlEncoder().withoutPadding()
        return enc.encodeToString("{\"alg\":\"RS256\"}".toByteArray()) + "." +
            enc.encodeToString(payload.toByteArray()) + ".sig"
    }

    @Test fun `reads a string claim`() {
        assertEquals("qa.user2@zipper.test", JwtClaims.string(jwt("{\"email\":\"qa.user2@zipper.test\",\"sub\":\"1\"}"), "email"))
    }

    @Test fun `absent, malformed or blank yields empty`() {
        assertEquals("", JwtClaims.string(jwt("{\"sub\":\"1\"}"), "email"))
        assertEquals("", JwtClaims.string("not-a-jwt", "email"))
        assertEquals("", JwtClaims.string(null, "email"))
        assertEquals("", JwtClaims.string(jwt("{\"email\":\"a@b.c\"}"), ""))
    }
}
