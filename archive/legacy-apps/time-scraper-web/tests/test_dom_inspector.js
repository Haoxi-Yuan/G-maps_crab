#!/usr/bin/env node
'use strict';

const { chromium } = require('playwright');

async function inspectDOM() {
  console.log('Launching browser to inspect DOM structure...\n');
  
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  
  // 使用一个真实的place_id
  const testUrl = 'https://www.google.com/maps/place/?q=place_id:ChIJaS3Tr08W2jERiy489bOlKhQ&hl=en';
  
  await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('h1', { timeout: 30000 });
  await page.waitForTimeout(2000);
  
  // 检查About标签页
  const aboutInfo = await page.evaluate(() => {
    const result = {
      hasAboutTab: false,
      aboutTabSelector: null,
      metadataElements: [],
      categoryElements: []
    };
    
    // 查找About标签
    const tabs = Array.from(document.querySelectorAll('button.hh2c6, button[role="tab"]'));
    const aboutTab = tabs.find(tab => tab.textContent.includes('About'));
    
    if (aboutTab) {
      result.hasAboutTab = true;
      result.aboutTabSelector = 'button.hh2c6';
    }
    
    // 查找metadata元素
    const metadataContainers = document.querySelectorAll('div.RcCsl');
    result.metadataElements = Array.from(metadataContainers).map((el, idx) => ({
      index: idx,
      html: el.innerHTML.substring(0, 200),
      hasButton: !!el.querySelector('button'),
      hasLink: !!el.querySelector('a'),
      dataTooltip: el.querySelector('[data-tooltip]')?.getAttribute('data-tooltip'),
      ariaLabel: el.querySelector('[aria-label]')?.getAttribute('aria-label')
    }));
    
    // 查找categories相关元素
    const categoryButtons = document.querySelectorAll('button[jsaction*="pane.rating.category"]');
    result.categoryElements = Array.from(categoryButtons).map(btn => ({
      text: btn.textContent.trim(),
      ariaLabel: btn.getAttribute('aria-label')
    }));
    
    return result;
  });
  
  console.log('=== DOM Inspection Results ===\n');
  console.log('About Tab:', aboutInfo.hasAboutTab ? 'Found' : 'Not Found');
  console.log('Metadata Elements:', aboutInfo.metadataElements.length);
  console.log('Category Elements:', aboutInfo.categoryElements.length);
  
  console.log('\n=== Metadata Sample ===');
  aboutInfo.metadataElements.slice(0, 3).forEach((meta, i) => {
    console.log(`\nMetadata ${i + 1}:`);
    console.log('  data-tooltip:', meta.dataTooltip);
    console.log('  aria-label:', meta.ariaLabel);
  });
  
  console.log('\n=== Categories ===');
  aboutInfo.categoryElements.forEach(cat => {
    console.log('  -', cat.text);
  });
  
  // 点击About标签页
  if (aboutInfo.hasAboutTab) {
    console.log('\n=== Clicking About Tab ===');
    await page.click('button.hh2c6:has-text("About")').catch(() => {});
    await page.waitForTimeout(1500);
    
    const aboutContent = await page.evaluate(() => {
      const result = {
        aboutSections: []
      };
      
      // 查找About内容区域
      const sections = document.querySelectorAll('div.iP2t7d.fontBodyMedium');
      result.aboutSections = Array.from(sections).map(section => {
        const h2 = section.querySelector('h2.iL3Qke');
        const category = h2 ? h2.textContent.trim() : null;
        
        const items = [];
        const ul = section.querySelector('ul.ZQ6we');
        if (ul) {
          const lis = ul.querySelectorAll('li');
          lis.forEach(li => {
            const div = li.querySelector('div');
            if (div) {
              const spans = div.querySelectorAll('span');
              if (spans.length >= 2) {
                items.push(spans[1].textContent.trim());
              }
            }
          });
        }
        
        return { category, items };
      });
      
      return result;
    });
    
    console.log('\n=== About Content ===');
    aboutContent.aboutSections.forEach(section => {
      console.log(`\n${section.category}:`);
      section.items.forEach(item => console.log(`  - ${item}`));
    });
  }
  
  console.log('\n=== Press Enter to close browser ===');
  await new Promise(resolve => {
    process.stdin.once('data', resolve);
  });
  
  await browser.close();
}

inspectDOM().catch(console.error);
