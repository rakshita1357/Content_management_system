package com.tvads.player;

import java.net.URI;
import java.util.Locale;

/** Turns what a person types on the TV into the address of the ad server (scheme://host[:port]), or rejects it. */
final class ServerAddress {
    private ServerAddress() { }

    /**
     * "192.168.1.20:8080", "http://192.168.1.20:8080/" and " HTTP://Host:8080/admin " all give a clean origin.
     * A bare host gets "http://" (the backend runs on the local network without https).
     *
     * @return the origin, or null when the text is not a usable address
     */
    static String normalize(String input) {
        if (input == null) return null;
        String text = input.trim();
        if (text.isEmpty() || text.indexOf(' ') >= 0) return null;
        if (!text.matches("(?i)^[a-z][a-z0-9+.-]*://.*")) text = "http://" + text;
        URI uri;
        try {
            uri = new URI(text);
        } catch (Exception e) {
            return null;
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) return null;
        String host = uri.getHost();
        if (host == null || host.isEmpty()) return null;
        int port = uri.getPort();
        return scheme + "://" + host.toLowerCase(Locale.ROOT) + (port > 0 ? ":" + port : "");
    }
}
