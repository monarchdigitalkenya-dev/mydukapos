package com.mydukapos.app;

import android.net.Uri;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * window.MyDukaLauncher — only for the app's own first-start screen (assets/launcher.html). It checks a shop link WITH THE SERVER
 * (/api/license-status: is the link active, which app is it for) before remembering it. The check here only keeps each app to its own
 * shops (a Hotel link does not open in the Shop app); what a device may see or do is always decided by the server.
 */
public class LauncherBridge {
    private final MainActivity act;
    LauncherBridge(MainActivity act) { this.act = act; }

    private boolean onLauncher() {
        final String[] u = {null};
        final Object lock = new Object();
        act.runOnUiThread(() -> { synchronized (lock) { u[0] = act.web.getUrl(); lock.notifyAll(); } });
        synchronized (lock) { try { lock.wait(1500); } catch (InterruptedException e) { return false; } }
        return u[0] != null && u[0].startsWith("file:///android_asset/");
    }

    @JavascriptInterface
    public String info() {
        try {
            JSONObject o = new JSONObject();
            o.put("appName", BuildConfig.APP_NAME);
            o.put("module", BuildConfig.MODULE);
            o.put("product", BuildConfig.PRODUCT);
            o.put("version", BuildConfig.VERSION_NAME);
            o.put("rootDomain", BuildConfig.ROOT_DOMAIN);
            return o.toString();
        } catch (Exception e) { return "{}"; }
    }

    /** "Use a different shop link" on the no-connection screen (assets/offline.html): forget the link and ask for one again. */
    @JavascriptInterface
    public void forget() {
        if (!onLauncher()) return;
        act.forgetShop();
    }

    @JavascriptInterface
    public void open(String raw, String cbId) {
        if (!onLauncher()) return;
        new Thread(() -> {
            JSONObject r = new JSONObject();
            try {
                String s = raw == null ? "" : raw.trim();
                if (!s.contains("://")) s = "https://" + s;
                Uri u = Uri.parse(s);
                if (!"https".equals(u.getScheme())) u = u.buildUpon().scheme("https").build();
                if (!MainActivity.isOurs(u)) throw new Exception("That is not a MyDukaPOS link. It looks like  yourshop." + BuildConfig.ROOT_DOMAIN);
                String c = u.getQueryParameter("c");
                String base = "https://" + u.getHost();
                String check = base + "/api/license-status" + (c != null ? "?c=" + Uri.encode(c) : "");
                HttpURLConnection con = (HttpURLConnection) new URL(check).openConnection();
                con.setConnectTimeout(15000); con.setReadTimeout(20000);
                con.setRequestProperty("Accept", "application/json");
                int code = con.getResponseCode();
                StringBuilder sb = new StringBuilder();
                try (BufferedReader br = new BufferedReader(new InputStreamReader(code < 400 ? con.getInputStream() : con.getErrorStream()))) {
                    String line; while ((line = br.readLine()) != null) sb.append(line);
                }
                JSONObject lic = new JSONObject(sb.toString());
                if (!lic.optBoolean("valid", false) && !"expired".equals(lic.optString("reason"))) throw new Exception("This link is not active. Check it with your provider.");
                String product = lic.optString("product", "shop");
                if (!BuildConfig.PRODUCT.equals(product)) throw new Exception("This link is for another MyDukaPOS app (" + product + "). Install that app, or use its link in the browser.");
                String link = base + BuildConfig.MODULE_PATH + (c != null ? "?c=" + Uri.encode(c) : "");
                r.put("ok", true); r.put("link", link);
                act.openShop(link);
            } catch (java.net.UnknownHostException | java.net.SocketTimeoutException | java.net.ConnectException e) {
                try { r.put("ok", false); r.put("error", "No connection to the server. The first start needs internet; after that the app also works offline."); } catch (Exception ignored) { }
            } catch (Exception e) {
                try { r.put("ok", false); r.put("error", e.getMessage() == null ? "The link could not be checked." : e.getMessage()); } catch (Exception ignored) { }
            }
            act.js("window.__launcherCb && window.__launcherCb(" + JSONObject.quote(cbId == null ? "" : cbId) + ", " + r.toString() + ")");
        }).start();
    }
}
