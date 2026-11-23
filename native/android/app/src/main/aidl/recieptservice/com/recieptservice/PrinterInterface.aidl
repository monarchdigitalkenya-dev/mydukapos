// Binder interface of the printer service that ships on Senraise-built Android handheld terminals (package
// "recieptservice.com.recieptservice"). Only the FIRST eleven methods are declared here, in the vendor's own order — the order fixes the
// Binder transaction numbers, so it must never be changed or reordered. Methods this app does not use are simply not declared (the
// service's later methods do not move these).
// Evidence: published open-source wrappers of the same service (MIT / BSD-3-Clause) —
//   github.com/shaxxx/flutter_senraise  and  github.com/Mrkrabss/flutter_senraise_printer_sdk.
// The vendor's own SDK/licence for the H10S has not been seen by the author; see docs/BUILTIN_PRINTER_336.md.
package recieptservice.com.recieptservice;

import android.graphics.Bitmap;

interface PrinterInterface {
    void printEpson(in byte[] data);
    String getServiceVersion();
    void printText(String text);
    void printBitmap(in Bitmap pic);
    void printBarCode(String data, int symbology, int height, int width);
    void printQRCode(String data, int modulesize, int errorlevel);
    void setAlignment(int alignment);
    void setTextSize(float textSize);
    void nextLine(int line);
    void printTableText(in String[] text, in int[] weight, in int[] alignment);
    void setTextBold(boolean bold);
}
