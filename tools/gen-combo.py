# Rebuilds src/shared/blocks/hmis-combo.html from website/combo.js (the one source for searchable dropdowns on the website and in the HMIS).
src=open('website/combo.js',encoding='utf8').read()
assert '</script' not in src
open('src/shared/blocks/hmis-combo.html','w',encoding='utf8').write('<!-- HMIS COMBO (zip 359): every dropdown becomes a typing field that narrows as you type. Source: website/combo.js (run tools/gen-combo.py after editing it). -->\n<script>\n'+src+'</script>\n')
