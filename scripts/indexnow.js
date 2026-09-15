// Tell Bing, Yandex and the other IndexNow engines that pages changed.
// Run after a deploy:  node scripts/indexnow.js [url ...]
// Google does not use IndexNow; it reads sitemap.xml and Search Console.
const fs = require("fs");
const path = require("path");
const host = "www.shalobot.com";
const key = fs.readdirSync(path.join(__dirname, "..")).find((f) => /^[a-f0-9]{32}\.txt$/.test(f)).slice(0, -4);
const urls = process.argv.slice(2);
const list = urls.length ? urls : [`https://${host}/`, `https://${host}/dashboard`];
fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "Content-Type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: list }),
}).then((r) => console.log("IndexNow", r.status, list.join(" ")));
