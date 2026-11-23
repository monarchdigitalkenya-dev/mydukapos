## Zip 308 - Kitchen orders show on the kitchen screen without the wait

- **The cause, measured** (real Hotel app on a waiter device and a kitchen screen, real server, shop database and live room): an order normally reached the kitchen in about 1.5-2.5 s, but whenever the instant "something changed" push did not reach the kitchen device (a phone or tablet that missed it), the order waited for the kitchen's 30-second safety check: **about 28 s**. On top of that the board only redrew on its own 3-second timer, and the waiter's device held the order for 300 ms before sending it.
- **Fixed:** a posted order (waiter, counter, bar sale) is sent the moment it is posted; the kitchen / bar board redraws the moment new data arrives; a device showing a kitchen or bar board asks its live connection "anything new?" every 6 s (a tiny message, 1/20 of a request), checked on the board's 3-second beat; a push whose first look found nothing new looks again at 0.8 s, 2.5 s and 6 s. **Missed push: ~28 s -> under 11 s (typically 3-6 s).** Other screens keep the 30-second check, so costs do not go up.
- QR orders: the 8-second check for new QR orders now runs every 30 s while the live connection is healthy (a QR order already reaches every device at once through it); every 8 s as before when it is not.
- Test `zip308-kitchen-latency`. Service worker zip-308.

