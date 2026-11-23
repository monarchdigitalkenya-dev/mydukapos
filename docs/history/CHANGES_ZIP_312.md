## Zip 312 - Sales Counter search finds every matching item

- **The cause:** the search list under the Sales Counter box stopped at the first 20 matches, in stock-list order. A shop with many similar names (e.g. 32 "Normal grey ... socks", most out of stock) filled all 20 places, so "socks" never showed the H&F socks, which only appeared when searching "H&F".
- **Fixed (Shop, Hotel, Pharmacy, Hospital, Services, Production):**
  - items **in stock come first**, then the best matches (exact code, names that start with the text, a word that starts with it), then A-Z;
  - up to **60** items are listed, and when there are more a note says "Showing 60 of N items. Type more of the name to narrow it down";
  - **every word counts, in any order:** "socks h&f", "h&f socks" and "black socks l" all work. The photo grid uses the same matching (Shop, Hospital, Services, Production).
- Shared functions `posSearchHit` / `posSearchRank` (src/shared/functions.js). Test `zip312-till-search` (6 apps). Service worker zip-312.
