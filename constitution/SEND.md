# שליחה — Velvet Factory (עותק מופע)

החוק החי בליבה: `vendor/velvetos-core/constitution/SEND.md`.  
בתוך Core עצמו: `constitution/SEND.md`. HQ שולח ג׳ימייל ואינסטגרם דרך כלים.

## לפני שיבוץ / Publish

1. ארטיפקט PREFLIGHT v2 כתוב (`vfgrowth/PREFLIGHT.md`) — VOICE + Canva/vfcovers + Rubric + Brand Guardian + QA final render.
2. שער עריכה (`EDIT-GATE.md`) — לא JPEG גולמי.
3. לסטורי: `copy_qa`, `brand_guardian`, `readability`, `contrast` חייבים להיות `PASS`; אין waiver לניגודיות חלשה.
4. ה־PREFLIGHT חייב לכלול `artifact_digest` ו־`final_package_sha256` של החבילה הסופית המדויקת. שינוי אחרי אישור מבטל אותו.
5. transport-only לא מאשר פרסום:
   `python3 vendor/velvetos-core/scripts/vf_send_preflight.py --gate instagram --transport-only`
6. לפני `publish_*` חובה exact-package gate:
   `python3 vendor/velvetos-core/scripts/vf_send_preflight.py --gate instagram --content-id <GID> --format <story|reel|carousel|post> --approval-ref packages/vfgrowth/preflight/<GID>.md --package-sha256 <SHA256>`
7. רק exit `0` + `publication_quality.publishAuthorized=true` = מותר לפרסם. אחרת **נכשל-סגור**.

## משטח כריסטיאן

רק החלטה / חסם קשיח / פרסום חי שדורש אותו.  
אל תפנה לכריסטיאן על מדדים חלשים. אין «רמה נמוכה» לצ׳אט.

אין אוטו־DM. אין בוסט בלי ראש צוות. אין ₪ / Insights מומצאים.
