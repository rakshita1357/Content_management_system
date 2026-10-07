package com.tvads.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class ServerAddressTest {
    @Test
    public void bareHostAndPortGetsHttp() {
        assertEquals("http://192.168.1.20:8080", ServerAddress.normalize("192.168.1.20:8080"));
        assertEquals("http://tvads.local:8080", ServerAddress.normalize("tvads.local:8080"));
        assertEquals("http://10.0.2.2:8080", ServerAddress.normalize("10.0.2.2:8080"));
    }

    @Test
    public void keepsSchemeAndDropsPathAndTrailingSlash() {
        assertEquals("http://192.168.1.20:8080", ServerAddress.normalize("http://192.168.1.20:8080/"));
        assertEquals("http://192.168.1.20:8080", ServerAddress.normalize("http://192.168.1.20:8080/admin?x=1"));
        assertEquals("https://ads.example.com", ServerAddress.normalize("https://ads.example.com/tv/"));
        assertEquals("https://ads.example.com:8443", ServerAddress.normalize("HTTPS://Ads.Example.com:8443"));
    }

    @Test
    public void trimsWhitespaceAroundTheAddress() {
        assertEquals("http://192.168.1.20:8080", ServerAddress.normalize("  192.168.1.20:8080\n"));
    }

    @Test
    public void rejectsWhatIsNotAnAddress() {
        assertNull(ServerAddress.normalize(null));
        assertNull(ServerAddress.normalize(""));
        assertNull(ServerAddress.normalize("   "));
        assertNull(ServerAddress.normalize("http://"));
        assertNull(ServerAddress.normalize("not an address"));
        assertNull(ServerAddress.normalize("ftp://192.168.1.20"));
        assertNull(ServerAddress.normalize("file:///sdcard/x"));
        assertNull(ServerAddress.normalize("javascript:alert(1)"));
    }
}
