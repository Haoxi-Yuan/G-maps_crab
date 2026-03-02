/**
 * Reviews Extractor by Scrolling
 * Can be integrated into pipeline or used standalone
 *
 * IMPORTANT: Page Loading Strategy
 * Google Maps requires a two-step loading process to show the full interface:
 * Step 1: Load search API URL first
 *   await page.goto('https://www.google.com/maps/search/?api=1&query=Google&query_place_id=${placeId}')
 * Step 2: Then load place URL
 *   await page.goto('https://www.google.com/maps/place/?q=place_id:${placeId}&hl=en')
 *
 * Without this two-step process, the page will only show Overview and About tabs,
 * missing the Reviews tab needed for extraction.
 *
 * This approach extracts reviews by:
 * 1. Clicking the Reviews tab (or Overview if Reviews not available)
 * 2. Scrolling the reviews container
 * 3. Extracting review data from DOM
 * 4. Handling images and reviewer information
 */

(function() {
    'use strict';

    async function extractReviewsByScrolling(options = {}) {
        const {
            maxReviews = 1000,
            maxScrolls = 1000,
            includeImages = true,
            scrollDelay = 500,
            reviewSort = 'relevant'  // 'relevant' (default) or 'newest'
        } = options;

        // Adaptive scroll delay: fast when content is actively loading, slow when idle
        const scrollDelayFast = scrollDelay;
        const scrollDelaySlow = Math.max(scrollDelay * 3, 1500);

        console.log('[Reviews] Starting extraction by scrolling...');
        console.log(`[Reviews] Config: maxReviews=${maxReviews}, maxScrolls=${maxScrolls}, scrollDelay=${scrollDelayFast}~${scrollDelaySlow}ms (adaptive)`);

        const sleep = ms => new Promise(r => setTimeout(r, ms));

        try {
            // Find and click Reviews tab (or Overview as fallback)
            const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
            console.log(`[Reviews] Found ${tabs.length} tabs: ${tabs.map(t => t.textContent.trim()).join(', ')}`);

            let targetTab = tabs.find(tab =>
                tab.textContent.toLowerCase().includes('review')
            );

            // Fallback to Overview if Reviews tab not found
            if (!targetTab) {
                console.warn('[Reviews] Reviews tab not found, trying Overview...');
                targetTab = tabs.find(tab =>
                    tab.textContent.toLowerCase().includes('overview')
                );
            }

            if (!targetTab) {
                console.warn('[Reviews] No suitable tab found');
                return [];
            }

            console.log(`[Reviews] Clicking "${targetTab.textContent.trim()}" tab...`);
            targetTab.click();
            await sleep(3000);

            // Sort reviews if requested (e.g. 'newest' instead of default 'relevant')
            if (reviewSort && reviewSort !== 'relevant') {
                console.log(`[Reviews] Attempting to sort by: ${reviewSort}`);
                const sortBtn = document.querySelector('button[aria-label="Sort reviews"], button[data-value="Sort"]');
                if (sortBtn) {
                    sortBtn.click();
                    await sleep(1500);

                    // Wait for menu items to appear
                    let menuFound = false;
                    for (let attempt = 0; attempt < 5; attempt++) {
                        const menuItems = document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]');
                        if (menuItems.length > 0) {
                            // Find the target sort option
                            const sortMap = {
                                'newest': /newest/i,
                                'highest': /highest/i,
                                'lowest': /lowest/i
                            };
                            const targetPattern = sortMap[reviewSort];
                            if (targetPattern) {
                                for (const item of menuItems) {
                                    const text = item.textContent.trim();
                                    if (targetPattern.test(text)) {
                                        console.log(`[Reviews] Selecting sort option: "${text}"`);
                                        item.click();
                                        menuFound = true;
                                        break;
                                    }
                                }
                            }
                            break;
                        }
                        await sleep(500);
                    }

                    if (menuFound) {
                        // Wait for reviews to reload after sort change
                        console.log('[Reviews] Waiting for reviews to reload after sort change...');
                        await sleep(3000);
                    } else {
                        console.warn('[Reviews] Sort menu items not found, continuing with default sort');
                    }
                } else {
                    console.warn('[Reviews] Sort button not found, continuing with default sort');
                }
            }

            // Find scrollable container
            const scrollableSelectors = [
                'div.m6QErb.DxyBCb.kA9KIf.dS8AEf',
                'div[role="main"]',
                '.section-layout',
                'div.m6QErb'
            ];

            let scrollContainer = null;
            let matchedSelector = null;
            for (const selector of scrollableSelectors) {
                const container = document.querySelector(selector);
                if (container) {
                    console.log(`[Reviews] Selector "${selector}": found, scrollHeight=${container.scrollHeight}, clientHeight=${container.clientHeight}, scrollable=${container.scrollHeight > container.clientHeight}`);
                    if (!scrollContainer && container.scrollHeight > container.clientHeight) {
                        scrollContainer = container;
                        matchedSelector = selector;
                    }
                } else {
                    console.log(`[Reviews] Selector "${selector}": not found`);
                }
            }

            if (scrollContainer) {
                console.log(`[Reviews] Using scroll container: "${matchedSelector}"`);
                // Reset scroll position to top
                scrollContainer.scrollTop = 0;
                await sleep(500);
            }

            if (!scrollContainer) {
                console.warn('[Reviews] Scrollable container not found');
                return [];
            }

            // Log initial review element count
            const initialElements = document.querySelectorAll('div.jftiEf, div.jJc9Ad, div[data-review-id]');
            console.log(`[Reviews] Initial review elements in DOM: ${initialElements.length}`);

            const reviews = [];
            const seenReviewIds = new Set();
            let scrollAttempts = 0;
            let bottomStuckCount = 0;
            let consecutiveEmptyScrolls = 0;

            // Track "+N more photos" buttons detected during scrolling (processed after Phase 1)
            const clickedMoreButtons = new Set();

            // Helper: click all "More" expand buttons to reveal full review text
            const clickExpandButtons = async () => {
                const selectors = [
                    'button.w8nwRe.kyuRq',
                    'button.w8nwRe',
                    'a.w8nwRe',
                ];
                let clicked = 0;
                for (const selector of selectors) {
                    const buttons = scrollContainer.querySelectorAll(selector);
                    for (const btn of buttons) {
                        try {
                            btn.click();
                            clicked++;
                        } catch (e) {}
                    }
                }
                if (clicked > 0) {
                    await sleep(500);
                }
                return clicked;
            };

            // Helper: extract reviews from current DOM state
            const extractCurrentReviews = () => {
                const reviewElements = document.querySelectorAll('div.jftiEf, div.jJc9Ad, div[data-review-id]');
                let newCount = 0;

                reviewElements.forEach((el) => {
                    if (reviews.length >= maxReviews) return;

                    try {
                        let container = el;
                        if (!el.querySelector('.d4r55')) {
                            let parent = el.parentElement;
                            for (let i = 0; i < 10 && parent; i++) {
                                if (parent.querySelector('.d4r55') && parent.textContent.length > 80) {
                                    container = parent;
                                    break;
                                }
                                parent = parent.parentElement;
                            }
                        }

                        const reviewId = container.getAttribute('data-review-id') ||
                                       container.querySelector('[data-review-id]')?.getAttribute('data-review-id') ||
                                       `scroll_${reviews.length}`;

                        if (seenReviewIds.has(reviewId)) return;
                        seenReviewIds.add(reviewId);

                        const review = {
                            review_id: reviewId,
                            rating: null,
                            review_text: null,
                            published_at: null,
                            published_at_date: null,
                            reviewer_name: null,
                            reviewer_link: null,
                            reviewer_photo_count: null,
                            reviewer_review_count: null,
                            is_local_guide: false,
                            review_likes_count: 0,
                            response_from_owner_text: null,
                            response_from_owner_ago: null
                        };

                        // Extract rating
                        const ratingEl = container.querySelector('[role="img"][aria-label*="star"]');
                        if (ratingEl) {
                            const match = ratingEl.getAttribute('aria-label').match(/(\d+)\s*star/i);
                            if (match) review.rating = parseInt(match[1]);
                        }

                        // Extract review text (try multiple selectors)
                        const textSelectors = [
                            'span.wiI7pd',
                            'div.MyEned span',
                            'span[jsan]'
                        ];
                        for (const selector of textSelectors) {
                            const textEl = container.querySelector(selector);
                            if (textEl && textEl.textContent.trim()) {
                                review.review_text = textEl.textContent.trim();
                                break;
                            }
                        }

                        // Extract published time
                        const timeEl = container.querySelector('span.rsqaWe, span.DZSIDd span');
                        if (timeEl) {
                            review.published_at = timeEl.textContent.trim();
                        }

                        // Extract reviewer name (try multiple specific selectors)
                        const nameSelectors = [
                            '.d4r55.fontTitleMedium',
                            'button[data-href*="/maps/contrib/"]',
                            'a[href*="/maps/contrib/"]',
                            '.d4r55',
                            'div.d4r55',
                            '[data-attrid="Reviewer name"]',
                            'button.WEBjve'
                        ];

                        for (const selector of nameSelectors) {
                            const candidateEl = container.querySelector(selector);
                            if (candidateEl) {
                                const text = candidateEl.textContent.trim();
                                const textLower = text.toLowerCase();

                                if (text &&
                                    !textLower.includes('more') &&
                                    !textLower.includes('photo') &&
                                    !textLower.includes('local guide') &&
                                    text.length < 100 &&
                                    text.split(' ').length <= 5) {
                                    review.reviewer_name = text;
                                    break;
                                }
                            }
                        }

                        // If still no name found, try to extract from aria-label
                        if (!review.reviewer_name) {
                            const buttonWithLabel = container.querySelector('button[aria-label]');
                            if (buttonWithLabel) {
                                const ariaLabel = buttonWithLabel.getAttribute('aria-label');
                                if (ariaLabel && !ariaLabel.toLowerCase().includes('more')) {
                                    const nameMatch = ariaLabel.match(/(?:photo of|profile of|by)\s+(.+)/i);
                                    if (nameMatch) {
                                        review.reviewer_name = nameMatch[1].trim();
                                    }
                                }
                            }
                        }

                        // Extract reviewer profile link (unique contributor ID)
                        const linkSelectors = [
                            'button[data-href*="/maps/contrib/"]',
                            'a[href*="/maps/contrib/"]'
                        ];
                        for (const selector of linkSelectors) {
                            const linkEl = container.querySelector(selector);
                            if (linkEl) {
                                const href = linkEl.getAttribute('data-href') || linkEl.getAttribute('href');
                                if (href) {
                                    review.reviewer_link = href;
                                    break;
                                }
                            }
                        }

                        // Extract reviewer stats from the dedicated stats element (div.RfnDt)
                        // This avoids false matches from review text or image button labels
                        const statsEl = container.querySelector('.RfnDt');
                        if (statsEl) {
                            const statsText = statsEl.textContent;
                            const photoMatch = statsText.match(/(\d+)\s*photo/i);
                            if (photoMatch) review.reviewer_photo_count = parseInt(photoMatch[1]);

                            const reviewMatch = statsText.match(/(\d+)\s*review/i);
                            if (reviewMatch) review.reviewer_review_count = parseInt(reviewMatch[1]);

                            if (statsText.toLowerCase().includes('local guide')) {
                                review.is_local_guide = true;
                            }
                        } else {
                            // Fallback: check container text but only from small stat-like spans
                            const fallbackSpans = container.querySelectorAll('span.RfnDt, div.RfnDt, span.e4ehTe');
                            for (const span of fallbackSpans) {
                                const text = span.textContent;
                                const photoMatch = text.match(/(\d+)\s*photo/i);
                                if (photoMatch) review.reviewer_photo_count = parseInt(photoMatch[1]);
                                const reviewMatch = text.match(/(\d+)\s*review/i);
                                if (reviewMatch) review.reviewer_review_count = parseInt(reviewMatch[1]);
                                if (text.toLowerCase().includes('local guide')) {
                                    review.is_local_guide = true;
                                }
                            }
                        }

                        // Extract owner response
                        const ownerResponse = container.querySelector('div.CDe7pd, div[class*="response"]');
                        if (ownerResponse) {
                            review.response_from_owner_text = ownerResponse.textContent.trim();
                        }

                        // Extract images if enabled
                        if (includeImages) {
                            const images = [];
                            const photoButtons = container.querySelectorAll('button[aria-label*="Photo"][aria-label*="review" i]:not([aria-label*="Photo of"])');

                            photoButtons.forEach(button => {
                                const imgs = button.querySelectorAll('img');
                                imgs.forEach(img => {
                                    const src = img.src || img.getAttribute('data-src');
                                    const isValidImage = src &&
                                        !src.includes('avatar') &&
                                        !src.includes('w36-h36') &&
                                        !src.includes('w40-h40') &&
                                        !src.includes('data:image') &&
                                        src.includes('googleusercontent');

                                    if (isValidImage && !images.includes(src)) {
                                        images.push(src);
                                    }
                                });

                                const style = window.getComputedStyle(button);
                                const backgroundImage = style.backgroundImage;

                                if (backgroundImage && backgroundImage !== 'none') {
                                    const urlMatch = backgroundImage.match(/url\(["']?([^"')]+)["']?\)/);
                                    if (urlMatch && urlMatch[1]) {
                                        const src = urlMatch[1];
                                        const isValidImage = src &&
                                            !src.includes('avatar') &&
                                            !src.includes('w36-h36') &&
                                            !src.includes('w40-h40') &&
                                            !src.includes('data:image') &&
                                            src.includes('googleusercontent');

                                        if (isValidImage && !images.includes(src)) {
                                            images.push(src);
                                        }
                                    }
                                }
                            });

                            if (images.length > 0) {
                                review.review_images = images;
                            }
                        }

                        if (review.rating || review.review_text) {
                            reviews.push(review);
                            newCount++;
                        }

                    } catch (err) {
                        console.error('[Reviews] Error extracting review:', err.message);
                    }
                });
                return newCount;
            };

            // Helper: perform a scroll and dispatch proper events to trigger lazy loading
            const performScroll = async (currentDelay) => {
                const scrollBefore = scrollContainer.scrollTop;
                const scrollHeightBefore = scrollContainer.scrollHeight;

                // Method 1: scrollBy (basic)
                scrollContainer.scrollBy(0, scrollContainer.clientHeight * 0.8);

                // Method 2: Dispatch scroll event to ensure Google Maps detects it
                scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

                // Wait for content to load (adaptive delay)
                await sleep(currentDelay);

                const scrollAfter = scrollContainer.scrollTop;
                const scrollHeightAfter = scrollContainer.scrollHeight;

                return {
                    scrollBefore,
                    scrollAfter,
                    scrollHeightBefore,
                    scrollHeightAfter,
                    moved: scrollAfter !== scrollBefore,
                    contentGrew: scrollHeightAfter > scrollHeightBefore
                };
            };

            // Main scrolling loop
            // Strategy: scroll until physically stuck at bottom AND no new content loads
            while (scrollAttempts < maxScrolls && reviews.length < maxReviews) {
                // Expand "More" text buttons before extraction
                await clickExpandButtons();

                // Extract reviews from current DOM
                const newReviewCount = extractCurrentReviews();

                // Adaptive delay: fast when content is actively loading, slow when idle
                if (newReviewCount > 0) {
                    consecutiveEmptyScrolls = 0;
                } else {
                    consecutiveEmptyScrolls++;
                }
                const currentDelay = consecutiveEmptyScrolls <= 2 ? scrollDelayFast : scrollDelaySlow;

                // Log progress every 10 scrolls (reduced frequency to save I/O)
                if (scrollAttempts % 10 === 0) {
                    console.log(`[Reviews] Scroll ${scrollAttempts}: ${reviews.length} reviews extracted (${newReviewCount} new), delay=${currentDelay}ms, scrollTop=${Math.round(scrollContainer.scrollTop)}, scrollHeight=${scrollContainer.scrollHeight}`);
                }

                // Detect "+N more photos" buttons in current viewport (record only, click later)
                if (includeImages) {
                    const morePhotosButtons = document.querySelectorAll('button.Tya61d[aria-label*="more photos"]');
                    for (const moreBtn of morePhotosButtons) {
                        const reviewId = moreBtn.getAttribute('data-review-id');
                        if (reviewId && !clickedMoreButtons.has(reviewId)) {
                            clickedMoreButtons.add(reviewId);
                            const ariaLabel = moreBtn.getAttribute('aria-label') || '';
                            console.log(`[Reviews] Detected "${ariaLabel}" for review ${reviewId} (will expand after scrolling)`);
                        }
                    }
                }

                // Perform scroll (with adaptive delay)
                const scrollResult = await performScroll(currentDelay);

                // If scroll didn't move (physically at the bottom)
                if (!scrollResult.moved) {
                    // Wait extra time for potential async content loading
                    await sleep(2000);

                    // Check if scrollHeight grew (new content loaded while we waited)
                    const latestScrollHeight = scrollContainer.scrollHeight;
                    if (latestScrollHeight > scrollResult.scrollHeightAfter) {
                        console.log(`[Reviews] At bottom but new content loaded: scrollHeight ${scrollResult.scrollHeightAfter} -> ${latestScrollHeight}`);
                        bottomStuckCount = 0;
                        scrollAttempts++;
                        continue;
                    }

                    bottomStuckCount++;
                    console.log(`[Reviews] Scroll stuck at bottom (attempt ${bottomStuckCount}/3), scrollTop=${Math.round(scrollResult.scrollAfter)}, scrollHeight=${latestScrollHeight}`);

                    if (bottomStuckCount >= 3) {
                        console.log(`[Reviews] Confirmed at bottom after ${bottomStuckCount} attempts. Final: ${reviews.length} reviews from ${scrollAttempts} scrolls`);
                        break;
                    }

                    // Try scrolling to absolute end to trigger loading
                    scrollContainer.scrollTop = scrollContainer.scrollHeight;
                    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
                    await sleep(2000);
                } else {
                    bottomStuckCount = 0;
                }

                scrollAttempts++;
            }

            console.log(`[Reviews] Scrolling complete: ${reviews.length} reviews from ${scrollAttempts} scrolls, ${clickedMoreButtons.size} "+N" buttons detected`);

            // ============ Phase 2: Expand detected "+N more photos" buttons ============
            if (includeImages && clickedMoreButtons.size > 0) {
                console.log(`[Reviews] Phase 2: Expanding ${clickedMoreButtons.size} "+N more photos" buttons...`);

                const reviewIndexMap = new Map();
                reviews.forEach((r, idx) => {
                    reviewIndexMap.set(r.review_id, idx);
                });

                const processedButtons = new Set();

                // Scroll back to top
                scrollContainer.scrollTop = 0;
                scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
                await sleep(1500);

                let phase2Scrolls = 0;
                let phase2BottomStuck = 0;

                while (phase2BottomStuck < 3 && processedButtons.size < clickedMoreButtons.size) {
                    // Find "+N" buttons in current viewport
                    const morePhotosButtons = document.querySelectorAll('button.Tya61d[aria-label*="more photos"]');
                    for (const moreBtn of morePhotosButtons) {
                        const reviewId = moreBtn.getAttribute('data-review-id');
                        if (!reviewId || processedButtons.has(reviewId)) continue;
                        if (!clickedMoreButtons.has(reviewId)) continue;

                        processedButtons.add(reviewId);
                        const ariaLabel = moreBtn.getAttribute('aria-label') || '';
                        console.log(`[Reviews] Phase 2: Expanding "${ariaLabel}" (${processedButtons.size}/${clickedMoreButtons.size})`);

                        // Save scroll position
                        const savedScrollTop = scrollContainer.scrollTop;

                        // Click "+N" button
                        moreBtn.click();
                        await sleep(1500);

                        // Extract all expanded photo URLs
                        const expandedButtons = document.querySelectorAll(`button.Tya61d[data-review-id="${reviewId}"]`);
                        const expandedImages = [];
                        expandedButtons.forEach(btn => {
                            const btnLabel = btn.getAttribute('aria-label') || '';
                            if (btnLabel.includes('more photos')) return;

                            const style = window.getComputedStyle(btn);
                            const bg = style.backgroundImage;
                            if (!bg || bg === 'none') return;

                            const urlMatch = bg.match(/url\(["']?([^"')]+)["']?\)/);
                            if (!urlMatch || !urlMatch[1]) return;

                            const src = urlMatch[1];
                            if (!src.includes('googleusercontent')) return;
                            if (src.includes('avatar') || src.includes('w36-h36') || src.includes('w40-h40')) return;

                            if (!expandedImages.includes(src)) {
                                expandedImages.push(src);
                            }
                        });

                        if (expandedImages.length > 0) {
                            const idx = reviewIndexMap.get(reviewId);
                            if (idx !== undefined) {
                                reviews[idx].review_images = expandedImages;
                            }
                            console.log(`[Reviews] Phase 2: ${expandedImages.length} photos extracted for review ${reviewId}`);
                        }

                        // Click Back button
                        const backBtn = document.querySelector('button[aria-label="Back"]');
                        if (backBtn) {
                            backBtn.click();
                            await sleep(2000);

                            // Re-find scroll container with retry (it may take time to rebuild)
                            let recovered = false;
                            for (let retry = 0; retry < 5; retry++) {
                                const newContainer = document.querySelector('div.m6QErb.DxyBCb.kA9KIf.dS8AEf');
                                if (newContainer && newContainer.scrollHeight > 0) {
                                    scrollContainer = newContainer;
                                    recovered = true;
                                    break;
                                }
                                await sleep(1000);
                            }

                            if (!recovered) {
                                console.warn('[Reviews] Phase 2: Failed to recover scroll container after Back, stopping Phase 2');
                                break;
                            }

                            // Restore scroll position
                            scrollContainer.scrollTop = savedScrollTop;
                            scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
                            await sleep(500);
                        }
                    }

                    // Scroll forward (same speed as Phase 1)
                    const scrollBefore = scrollContainer.scrollTop;
                    scrollContainer.scrollBy(0, scrollContainer.clientHeight * 0.8);
                    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
                    await sleep(scrollDelay);

                    const scrollAfter = scrollContainer.scrollTop;
                    if (scrollAfter === scrollBefore) {
                        phase2BottomStuck++;
                    } else {
                        phase2BottomStuck = 0;
                    }

                    phase2Scrolls++;
                    if (phase2Scrolls % 10 === 0) {
                        console.log(`[Reviews] Phase 2: ${phase2Scrolls} scrolls, ${processedButtons.size}/${clickedMoreButtons.size} buttons expanded`);
                    }
                }

                console.log(`[Reviews] Phase 2 complete: expanded ${processedButtons.size}/${clickedMoreButtons.size} "+N" buttons`);
            }

            console.log(`[Reviews] Extraction complete: ${reviews.length} reviews`);
            return reviews;

        } catch (err) {
            console.error('[Reviews] Extraction failed:', err.message);
            return [];
        }
    }

    // Export for external use
    if (typeof window !== 'undefined') {
        window.extractReviewsByScrolling = extractReviewsByScrolling;
    }

    // Can be called directly or as async function
    return extractReviewsByScrolling;

})();
