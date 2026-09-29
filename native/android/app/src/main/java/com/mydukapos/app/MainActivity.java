package com.mydukapos.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.splashscreen.SplashScreen;

/**
 * MyDukaPOS for Android. The POS itself is the MyDukaPOS web app of this shop (its own address, e.g. georgehardware.mydukapos.store),
 * run in a WebView with durable storage (the web app keeps every sale on the device and syncs by itself — offline included). What the
 * WebView cannot do on its own, this app adds natively (see NativeBridge): Android printing (window.print does nothing in a WebView),
 * Bluetooth thermal printers (ESC/POS over Bluetooth SPP), camera for barcode scanning, and links to WhatsApp / phone / e-mail.
 *
 * First start: the launcher (assets/launcher.html) asks for the shop's link; the link is checked with the server (licence and module:
 * a Hotel link does not open in the Shop app) and remembered. After that the app opens straight into the shop — with or without internet.
 */
public class MainActivity extends Activity {
    static final String PREFS = "mydukapos";
    static final String KEY_LINK = "shop_link";
    private static final int REQ_CAMERA = 11;
    static final int REQ_BLUETOOTH = 12;

    WebView web;
    private NativeBridge bridge;
    private PermissionRequest pendingPermission;
    private ValueCallback<Uri[]> fileCallback;
    private static final int REQ_FILE = 21;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        SplashScreen.installSplashScreen(this);
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // localStorage: the POS's own durable store
        s.setDatabaseEnabled(true);                   // IndexedDB: the sales journal
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // the web app can tell it runs in this app (Settings ▸ Install App shows it; printing offers the app's printers)
        s.setUserAgentString(s.getUserAgentString() + " MyDukaPOS-Android/" + BuildConfig.MODULE + "/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);

        bridge = new NativeBridge(this);
        web.addJavascriptInterface(bridge, "MyDukaNative");
        web.addJavascriptInterface(new LauncherBridge(this), "MyDukaLauncher");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (isOurs(u) || "file".equals(u.getScheme())) return false;          // the shop stays in the app
                openOutside(u);                                                       // WhatsApp, tel:, mailto:, other sites
                return true;
            }
            /** The shop's page could not be loaded at all (no internet on the very first open, DNS, server down): show the app's own
             *  "Can't reach your shop" screen, which keeps trying and opens the shop by itself, instead of the browser's error page. */
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame() && isOurs(req.getUrl())) showOffline(req.getUrl().toString());
            }
            /** The server answered with a failure page (Cloudflare 5xx while the shop's server restarts): same friendly screen, same automatic retry. */
            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest req, android.webkit.WebResourceResponse res) {
                if (req != null && req.isForMainFrame() && isOurs(req.getUrl()) && res != null && res.getStatusCode() >= 500) showOffline(req.getUrl().toString());
            }
            /** A certificate problem (most often the phone's date / time is wrong): never load the page, say so and keep retrying. */
            @Override
            public void onReceivedSslError(WebView view, android.webkit.SslErrorHandler handler, android.net.http.SslError error) {
                handler.cancel();
                String u = error == null ? null : error.getUrl();
                if (u != null && isOurs(Uri.parse(u))) showOffline(u);
            }
            /** The page's process was killed (low memory) or crashed: without this the whole app dies. Reload the shop; its data is on the device and server. */
            @Override
            public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                runOnUiThread(() -> {
                    try { ((android.view.ViewGroup) web.getParent()).removeView(web); web.destroy(); } catch (Exception e) { /* already gone */ }
                    recreate();
                });
                return true;
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                // window.print() does nothing in a WebView: route it to Android printing (the page printed is the one on screen)
                if (isOurs(Uri.parse(url))) {
                    view.evaluateJavascript("(function(){ if (window.__myDukaPrintHooked) return; window.__myDukaPrintHooked = true;"
                            + " window.print = function(){ try { MyDukaNative.printPage(document.title || 'MyDukaPOS'); } catch (e) {} }; })();", null);
                }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                // camera for the barcode scanner — only for our own pages, and only with the user's Android permission
                if (!isOurs(request.getOrigin())) { request.deny(); return; }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(request.getResources());
                } else {
                    pendingPermission = request;
                    requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
                }
            }
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try { startActivityForResult(params.createIntent(), REQ_FILE); } catch (ActivityNotFoundException e) { fileCallback = null; return false; }
                return true;
            }
        });

        String link = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_LINK, null);
        // Owner Console app: always the one fixed address (https://<root domain>/owner/) — no shop link, no licence check; the console has its own login
        if (BuildConfig.FIXED) link = "https://" + BuildConfig.ROOT_DOMAIN + BuildConfig.MODULE_PATH;
        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else if (link != null) web.loadUrl(link);
        else web.loadUrl("file:///android_asset/launcher.html");
    }

    /** Only the MyDukaPOS domain (and its shops' subdomains) run inside the app and may use the native features. */
    static boolean isOurs(Uri u) {
        if (u == null || !"https".equals(u.getScheme()) || u.getHost() == null) return false;
        String h = u.getHost().toLowerCase();
        String root = BuildConfig.ROOT_DOMAIN;
        return h.equals(root) || h.endsWith("." + root);
    }

    boolean currentPageIsOurs() {
        String u = web == null ? null : web.getUrl();
        return u != null && (isOurs(Uri.parse(u)) || u.startsWith("file:///android_asset/"));
    }

    void openOutside(Uri u) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException e) { /* nothing can open it */ }
    }

    void printCurrentPage(String title) {
        runOnUiThread(() -> {
            PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
            String job = (title == null || title.isEmpty() ? "MyDukaPOS" : title);
            final PrintDocumentAdapter inner = web.createPrintDocumentAdapter(job);
            // the page keeps its print layout until Android says the job is finished — then it gets its 'afterprint' (see printReceiptInNewWindow)
            PrintDocumentAdapter adapter = new PrintDocumentAdapter() {
                @Override public void onStart() { inner.onStart(); }
                @Override public void onLayout(PrintAttributes o, PrintAttributes n, android.os.CancellationSignal c, LayoutResultCallback cb, Bundle x) { inner.onLayout(o, n, c, cb, x); }
                @Override public void onWrite(android.print.PageRange[] p, android.os.ParcelFileDescriptor d, android.os.CancellationSignal c, WriteResultCallback cb) { inner.onWrite(p, d, c, cb); }
                @Override public void onFinish() { inner.onFinish(); js("window.dispatchEvent(new Event('afterprint'))"); }
            };
            pm.print(job, adapter, new PrintAttributes.Builder().build());
        });
    }

    void showOffline(String failedUrl) {
        String cur = web == null ? null : web.getUrl();
        if (cur != null && cur.startsWith("file:///android_asset/offline.html")) return;      // already showing it
        final String to = "file:///android_asset/offline.html?u=" + Uri.encode(failedUrl);
        runOnUiThread(() -> web.loadUrl(to));
    }

    void openShop(String link) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_LINK, link).apply();
        runOnUiThread(() -> { web.clearHistory(); web.loadUrl(link); });
    }

    void forgetShop() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_LINK).apply();
        runOnUiThread(() -> web.loadUrl("file:///android_asset/launcher.html"));
    }

    void js(String script) { runOnUiThread(() -> web.evaluateJavascript(script, null)); }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQ_CAMERA && pendingPermission != null) {
            if (granted) pendingPermission.grant(pendingPermission.getResources()); else pendingPermission.deny();
            pendingPermission = null;
        } else if (requestCode == REQ_BLUETOOTH) {
            bridge.onBluetoothPermission(granted);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            fileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onPause() {
        super.onPause();
        try { CookieManager.getInstance().flush(); } catch (Exception e) { /* housekeeping */ }   // the sign-in cookies reach disk before Android may kill the app
    }

    @Override
    protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); web.saveState(out); }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }

    boolean needsBluetoothPermission() {
        return Build.VERSION.SDK_INT >= 31 && checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED;
    }

    SharedPreferences prefs() { return getSharedPreferences(PREFS, MODE_PRIVATE); }
}
