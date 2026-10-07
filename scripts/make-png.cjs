const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.setContent(
    '<body style="margin:0;background:linear-gradient(45deg,#030712,#1d4ed8);color:#fff;font:700 40px sans-serif;display:flex;align-items:center;justify-content:center">CourseHelper</body>'
  );
  await page.screenshot({ path: 'src/main/testpage/frame.jpg', type: 'jpeg' });
  await browser.close();
  console.log('png ok');
})();
