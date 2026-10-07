package com.tvads.player;

import android.annotation.TargetApi;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.SystemClock;
import android.text.InputType;
import android.view.View;
import android.view.WindowManager;
import android.webkit.HttpAuthHandler;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * The whole app: a full-screen WebView that shows the repo's web-core/ page.
 *
 * The page is served from the app's own assets under a fake secure origin (https://tv.local), so it opens even when the
 * network or the ad server is down. Only config.js is generated here: it tells the page where the ad server is.
 * Everything else (playback, offline cache, sync) is the same code the browser version runs.
 */
public class MainActivity extends Activity {
    private static final String APP_HOST = "tv.local";
    private static final String APP_URL = "https://" + APP_HOST + "/index.html";
    private static final String PREFS = "tvads";
    private static final String KEY_SERVER = "server";

    private WebView web;
    private long lastBackAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);   // a signage screen must not go to sleep
        web = new WebView(this);
        web.setBackgroundColor(0xFF0F2233);
        setContentView(web);
        configure(web);
        hideSystemUi();
        if (server() == null) {
            showServerDialog();
        } else {
            web.loadUrl(APP_URL);
        }
    }

    private void configure(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);               // ads start and play with sound without a key press
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);   // the https app page talks to the http ad server
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
        view.addJavascriptInterface(new Bridge(), "TVNative");
        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(new AppClient());
    }

    /** The ad server address: what was typed on the TV, else the one built into the app, else null. */
    private String server() {
        String saved = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, null);
        String address = ServerAddress.normalize(saved);
        if (address == null) address = ServerAddress.normalize(BuildConfig.DEFAULT_SERVER);
        return address;
    }

    // ---------------------------------------------------------------- page assets

    private final class AppClient extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (!APP_HOST.equals(uri.getHost())) return null;         // everything else (ad server, fonts) uses the network
            return serveAsset(uri.getPath());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            // Only the app itself and the ad server may be opened in this window.
            Uri uri = request.getUrl();
            if (APP_HOST.equals(uri.getHost())) return false;
            String origin = server();
            if (origin == null || !origin.equals(uri.getScheme() + "://" + uri.getAuthority())) return true;
            // The backend's front page ends by opening its own copy of the TV page (/tv/). Inside the app that must be
            // the app's own page instead: it has the saved ads (its own storage) and works without the server.
            String path = uri.getPath();
            if (path != null && (path.equals("/tv") || path.startsWith("/tv/"))) {
                view.loadUrl(APP_URL);
                return true;
            }
            return false;
        }

        @Override
        public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
            showAuthDialog(handler, host);
        }

        @Override
        @TargetApi(Build.VERSION_CODES.O)
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The web engine crashed or was killed to free memory: start the screen again instead of staying black.
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    recreate();
                }
            });
            return true;
        }
    }

    private WebResourceResponse serveAsset(String path) {
        String name = (path == null || path.equals("/")) ? "index.html" : path.substring(1);
        if (!name.matches("[A-Za-z0-9._-]+")) return response(404, "Not Found", "text/plain", new ByteArrayInputStream(new byte[0]));
        try {
            InputStream in;
            if (name.equals("config.js")) {
                String address = server();
                String js = "window.TV_CONFIG = { apiBase: " + JSONObject.quote(address == null ? "" : address) + ", cacheMaxMb: 0 };";
                in = new ByteArrayInputStream(js.getBytes(StandardCharsets.UTF_8));
            } else {
                in = getAssets().open("web/" + name);
            }
            return response(200, "OK", mimeOf(name), in);
        } catch (IOException e) {
            return response(404, "Not Found", "text/plain", new ByteArrayInputStream(new byte[0]));
        }
    }

    private static WebResourceResponse response(int code, String reason, String mime, InputStream body) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(mime, "utf-8", code, reason, headers, body);
    }

    private static String mimeOf(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".js")) return "application/javascript";
        if (name.endsWith(".json")) return "application/json";
        if (name.endsWith(".svg")) return "image/svg+xml";
        if (name.endsWith(".png")) return "image/png";
        return "application/octet-stream";
    }

    // ---------------------------------------------------------------- calls from the page (window.TVNative)

    private final class Bridge {
        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    showServerDialog();
                }
            });
        }

        @JavascriptInterface
        public String serverAddress() {
            String address = server();
            return address == null ? "" : address;
        }
    }

    // ---------------------------------------------------------------- dialogs

    private void showServerDialog() {
        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        String current = server();
        input.setText(current == null ? "http://" : current);
        input.setSelection(input.getText().length());

        final AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Ad server address")
                .setMessage("Address of the computer that runs the TV ads backend, for example 192.168.1.20:8080")
                .setView(input)
                .setPositiveButton("Save", null)          // set below so an invalid address keeps the dialog open
                .setNegativeButton("Cancel", null)
                .create();
        dialog.setCancelable(current != null);
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                String address = ServerAddress.normalize(input.getText().toString());
                if (address == null) {
                    input.setError("Use an address like 192.168.1.20:8080");
                    return;
                }
                SharedPreferences.Editor edit = getSharedPreferences(PREFS, MODE_PRIVATE).edit();
                edit.putString(KEY_SERVER, address).apply();
                dialog.dismiss();
                web.loadUrl(APP_URL);   // loads again with the new address in config.js
            }
        });
    }

    private void showAuthDialog(final HttpAuthHandler handler, String host) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (16 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, pad, pad, 0);
        final EditText user = new EditText(this);
        user.setHint("User name");
        user.setSingleLine(true);
        final EditText pass = new EditText(this);
        pass.setHint("Password");
        pass.setSingleLine(true);
        pass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        box.addView(user);
        box.addView(pass);
        new AlertDialog.Builder(this)
                .setTitle("Sign in to " + host)
                .setView(box)
                .setPositiveButton("Sign in", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int which) {
                        handler.proceed(user.getText().toString(), pass.getText().toString());
                    }
                })
                .setNegativeButton("Cancel", new android.content.DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(android.content.DialogInterface d, int which) {
                        handler.cancel();
                    }
                })
                .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
                    @Override
                    public void onCancel(android.content.DialogInterface d) {
                        handler.cancel();
                    }
                })
                .show();
    }

    // ---------------------------------------------------------------- remote control and screen

    @Override
    public void onBackPressed() {
        // 1. the player (Back leaves the ads and shows the list)  2. browser history (e.g. after "Change Drive folder")
        // 3. otherwise ignore, so a stray Back press never closes a running signage screen; twice in 2 s exits.
        web.evaluateJavascript("(function(){return !!(window.TV_NATIVE_BACK && window.TV_NATIVE_BACK());})()", new android.webkit.ValueCallback<String>() {
            @Override
            public void onReceiveValue(String consumed) {
                if ("true".equals(consumed)) return;
                if (web.canGoBack()) {
                    web.goBack();
                    return;
                }
                long now = SystemClock.uptimeMillis();
                if (now - lastBackAt < 2000) {
                    finish();
                    return;
                }
                lastBackAt = now;
                Toast.makeText(MainActivity.this, "Press Back again to exit", Toast.LENGTH_SHORT).show();
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemUi();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemUi() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
