# AvmaDrive

ლოკალური ფოტო/ვიდეო გალერეის მენეჯერი (PWA). ფაილები კომპიუტერიდან/ტელეფონიდან არსად იტვირთება.

## სტრუქტურა
```
index.html              გვერდი (მარკაპი)
assets/css/             tailwind.css, fontawesome.css, inter.css
assets/js/app.js        მთელი ლოგიკა
assets/fonts/           შრიფტები
assets/guide/           გზამკვლევის ანაბეჭდები
assets/icons/           აპის ხატულები
manifest.webmanifest    PWA
sw.js                   ოფლაინ ქეში
AvmaDrive.bat           ლოკალური გაშვება Windows-ზე
```

## ლოკალურად გატესტვა
- **Windows:** ორჯერ დააჭირე `AvmaDrive.bat`-ს. გაეშვება პატარა სერვერი `http://localhost:8765/` და გაიხსნება Chrome/Edge.
- **სხვა სისტემა:** საქაღალდეში `python3 -m http.server 8765`, შემდეგ `http://localhost:8765/`.
- `index.html`-ის პირდაპირ გახსნაც (`file://`) მუშაობს, მაგრამ საქაღალდის მუდმივი წვდომა და ინსტალაცია მხოლოდ `localhost`-ზე/HTTPS-ზე მუშაობს.

## გამოქვეყნება (GitHub → Vercel)
ატვირთე **მთელი საქაღალდის შიგთავსი** რეპოზიტორიის ძირში (`index.html` ძირში უნდა იყოს). ძველი ფაილები (`icon-192.png`, `icon-512.png` ძირში, ძველი `index.html`, `sw.js`) ჩაანაცვლე ან წაშალე.

## განახლებისას
`index.html`-ში `?v=2` და `sw.js`-ში `VER` გაზარდე, რომ ბრაუზერმა ახალი ფაილები აიღოს.

## Tailwind-ის თავიდან აგება (საჭიროა მხოლოდ კლასების ცვლილებისას)
`npm i tailwindcss@3.4.17`, config: `darkMode:'class'`, content: `index.html`, `assets/js/*.js`; შემდეგ `npx tailwindcss -i in.css -o assets/css/tailwind.css --minify` (`in.css`: `@tailwind base;@tailwind components;@tailwind utilities;`).
