# WA Downloader — Windows & Linux

نفس تطبيق الأندرويد، لسطح المكتب. يحمّل الملفات التي تصل إلى واتساب ويدمج الأجزاء المتتالية.

## لا يحتاج Qt ولا .NET ولا متصفح
مبني بـ Electron، فيحمل معه محرك العرض كاملاً. يعمل على Windows 10/11 (بما فيها النسخ المخففة مثل Ghost Spectre) وعلى معظم توزيعات لينكس.

## التشغيل
- **Windows:** شغّل `WA-Downloader-x.x.x-portable.exe` مباشرة (بدون تثبيت).
- **Linux:** `chmod +x WA-Downloader-*.AppImage && ./WA-Downloader-*.AppImage`
  أو فك `tar.gz` وشغّل الملف التنفيذي بداخله.
  إذا أغلق فوراً بدون رسالة، شغّله هكذا: `./WA-Downloader-*.AppImage --no-sandbox`
- **وضع المتصفح (احتياطي):** مع Node 20+: `npm install && npm run web` ثم افتح الرابط الذي يظهر.

## البناء
ارفع المجلد إلى GitHub وسيعمل الـ workflow. الملفات في Actions ← Artifacts.

## مكان الملفات
`Downloads/my downloading file` (يمكن تغيير الاسم والموقع من الإعدادات).
بيانات الجلسة: `%APPDATA%/WA Downloader` على ويندوز، و `~/.config/WA Downloader` على لينكس.

> Baileys مكتبة غير رسمية وقد يحظر واتساب الحساب؛ استخدم رقماً لا تخسر منه.
