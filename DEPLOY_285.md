# Zip 285 - deploy

1. Shared demo, "Your link is ready" popup: ONLY the X button closes it now. A tap outside the popup or the Escape key no longer closes it, so the client cannot lose the link by accident. Other screens of the popup behave as before.
2. Hotel / Restaurant: the 🍺 Bar & Kegs tab was blank. A startup routine moved its screen into Inventory (zip 153); zip 283 gave the tab back but left that move in place. The move is removed, and the "Bar & Kegs" chip inside Inventory now opens the Bar & Kegs tab.

Deploy as usual (the router did not change, so no deploy:router): see DEPLOY_284.md, steps 1-4, 9-10, 13. Then hard-refresh each app (Ctrl+F5) so the old copy is not served from the browser cache.
