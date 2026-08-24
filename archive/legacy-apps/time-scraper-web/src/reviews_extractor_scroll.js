/**
 * Smart Reviews Extractor
 *
 * Self-adapting review extraction with automatic strategy selection:
 * - Detects total review count from "N reviews" button
 * - Small places (<1500): single-pass, full extraction expected
 * - Large places (>1500): multi-sort strategy (newest → relevant → highest → lowest)
 *   to bypass Google's ~4000-5000 per-sort pagination limit
 * - CSS injection for non-scrollable containers
 * - scrollIntoView to trigger IntersectionObserver-based lazy loading
 * - Adaptive scroll speed and stuck detection
 */

(function() {
    'use strict';

    async function extractReviewsByScrolling(options = {}) {
        const {
            maxReviews = 1000,
            maxScrolls = 1000,
            includeImages = true,
            scrollDelay = 500,
            reviewSort = 'relevant'
        } = options;

        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const reviews = [];
        const seenReviewIds = new Set();
        let detectedReviewCount = null;
        let lastFlushIndex = 0;  // Track what's been flushed to disk

        // Periodic flush: if caller exposed __flushReviews, call it every 100 reviews
        // This prevents data loss if timeout kills the evaluate
        const flushToDisk = async () => {
            if (typeof window.__flushReviews === 'function' && reviews.length > lastFlushIndex) {
                const newReviews = reviews.slice(lastFlushIndex);
                try {
                    await window.__flushReviews(JSON.stringify(newReviews));
                    console.log(`[Reviews] Flushed ${newReviews.length} reviews to disk (total: ${reviews.length})`);
                    lastFlushIndex = reviews.length;
                } catch (e) {
                    console.warn(`[Reviews] Flush failed: ${e.message}`);
                }
            }
        };

        console.log('[Reviews] Starting smart extraction...');
        console.log(`[Reviews] Incremental flush: ${typeof window.__flushReviews === 'function' ? 'ENABLED' : 'DISABLED (no __flushReviews exposed)'}`);
        console.log(`[Reviews] Config: maxReviews=${maxReviews}, maxScrolls=${maxScrolls}, requestedSort=${reviewSort}`);

        try {
            // ================================================================
            // PHASE 0: LOCATE ENTRY — Find and click Reviews tab
            // ================================================================
            const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
            console.log(`[Reviews] Found ${tabs.length} tabs: ${tabs.map(t => t.textContent.trim()).join(', ')}`);

            let targetTab = tabs.find(tab => tab.textContent.toLowerCase().includes('review'));
            if (!targetTab) {
                targetTab = tabs.find(tab => tab.textContent.toLowerCase().includes('overview'));
            }
            if (!targetTab) {
                return { reviews: [], error: 'reviews_tab_not_found', detectedReviewCount };
            }

            // ================================================================
            // PHASE 1: DETECT — Read total review count BEFORE tab click
            // The "N reviews" button is visible on Overview tab but may disappear after clicking Reviews.
            // Strategy: collect ALL numbers next to "reviews" text, take the LARGEST one
            // (total count is always larger than any individual reviewer's review count).
            // ================================================================
            const detectReviewCount = () => {
                // Three reliable sources, in priority order:
                // 1. aria-label that is EXACTLY "N reviews" (span/button)
                // 2. Element whose OWN text (not children) is exactly "N reviews"
                // 3. "More reviews (N)" button aria-label
                // AVOID: textContent of parent elements (concatenates nested text → garbage numbers)

                let best = 0;

                // Source 1: aria-label exact match
                for (const el of document.querySelectorAll('[aria-label]')) {
                    const aria = el.getAttribute('aria-label') || '';
                    const m = aria.match(/^([\d,]+)\s+reviews?$/i);
                    if (m) {
                        const num = parseInt(m[1].replace(/[\D]/g, ''), 10);
                        if (num > best && num < 10000000) best = num;
                    }
                }

                // Source 2: direct text node match (no children text contamination)
                for (const el of document.querySelectorAll('button, span')) {
                    const ownText = Array.from(el.childNodes)
                        .filter(n => n.nodeType === 3)
                        .map(n => n.textContent.trim())
                        .join('');
                    const m = ownText.match(/^([\d,]+)\s+reviews?$/i);
                    if (m) {
                        const num = parseInt(m[1].replace(/[\D]/g, ''), 10);
                        if (num > best && num < 10000000) best = num;
                    }
                }

                // Source 3: "More reviews (N)" button
                for (const el of document.querySelectorAll('button')) {
                    const aria = el.getAttribute('aria-label') || '';
                    const text = el.textContent.trim();
                    for (const str of [aria, text]) {
                        const m = str.match(/More reviews\s*\(([\d,]+)\)/i);
                        if (m) {
                            const num = parseInt(m[1].replace(/[\D]/g, ''), 10);
                            if (num > best && num < 10000000) best = num;
                        }
                    }
                }

                return best > 0 ? best : null;
            };
            detectedReviewCount = detectReviewCount();
            console.log(`[Reviews] Detected total: ${detectedReviewCount || 'unknown'} reviews`);

            // Strategy decision
            const effectiveMax = detectedReviewCount
                ? Math.min(maxReviews, detectedReviewCount)
                : maxReviews;

            // Single sort only — just scroll to the end
            const sortPlan = [reviewSort || 'newest'];
            console.log(`[Reviews] Strategy: SINGLE-SORT (${sortPlan[0]}), target ${effectiveMax}`);

            // Click Reviews tab now (after detection)
            console.log(`[Reviews] Clicking "${targetTab.textContent.trim()}" tab...`);
            targetTab.click();
            await sleep(3000);

            // ================================================================
            // PHASE 2: EXTRACT — Scroll loop with sort switching
            // ================================================================

            // --- Helpers ---

            const ensureScrollable = (container) => {
                // If container can't scroll, inject CSS to force it
                const before = container.scrollTop;
                container.scrollTop = 100;
                const canScroll = container.scrollTop > before;
                container.scrollTop = before;
                if (!canScroll) {
                    console.log(`[Reviews] Container not scrollable (overflow=${getComputedStyle(container).overflowY}), injecting CSS`);
                    container.style.overflowY = 'auto';
                    container.style.maxHeight = '80vh';
                }
                return container;
            };

            const findContainer = async () => {
                for (const waitMs of [0, 1000, 2000, 3000]) {
                    if (waitMs) await sleep(waitMs);
                    const candidates = document.querySelectorAll('div.m6QErb.DxyBCb.kA9KIf.dS8AEf');
                    for (const c of candidates) {
                        if (c.querySelectorAll('div[data-review-id], div.jftiEf').length > 0) {
                            return ensureScrollable(c);
                        }
                    }
                }
                return null;
            };

            const selectSort = async (sortName) => {
                // Map sort names to menu option text
                const sortMap = {
                    'newest': 'Newest', 'relevant': 'Most relevant',
                    'highest': 'Highest rating', 'lowest': 'Lowest rating'
                };
                const target = sortMap[sortName] || sortName;

                const sortBtn = document.querySelector('button[aria-label*="Sort"], button[data-value="Sort"]');
                if (!sortBtn) {
                    console.warn(`[Reviews] Sort button not found, skipping sort change`);
                    return false;
                }
                sortBtn.click();
                await sleep(1500);

                // Find menu item
                const menuItems = document.querySelectorAll('div[role="menuitemradio"], li[role="menuitemradio"], div[data-index]');
                for (const item of menuItems) {
                    if (item.textContent.trim().toLowerCase().includes(target.toLowerCase())) {
                        item.click();
                        console.log(`[Reviews] Switched sort to: ${target}`);
                        await sleep(3000); // Wait for reviews to reload
                        return true;
                    }
                }
                console.warn(`[Reviews] Sort option "${target}" not found in menu`);
                // Close menu by clicking elsewhere
                sortBtn.click();
                await sleep(500);
                return false;
            };

            const clickExpandButtons = async (container) => {
                let clicked = 0;
                for (const sel of ['button.w8nwRe.kyuRq', 'button.w8nwRe', 'a.w8nwRe']) {
                    for (const btn of container.querySelectorAll(sel)) {
                        try { btn.click(); clicked++; } catch (e) {}
                    }
                }
                if (clicked > 0) await sleep(300);
                return clicked;
            };

            const extractFromDOM = (container) => {
                const elements = document.querySelectorAll('div.jftiEf, div.jJc9Ad, div[data-review-id]');
                let newCount = 0;

                elements.forEach(el => {
                    if (reviews.length >= effectiveMax) return;

                    try {
                        let reviewContainer = el;
                        if (!el.querySelector('.d4r55')) {
                            let parent = el.parentElement;
                            for (let i = 0; i < 10 && parent; i++) {
                                if (parent.querySelector('.d4r55') && parent.textContent.length > 80) {
                                    reviewContainer = parent; break;
                                }
                                parent = parent.parentElement;
                            }
                        }

                        const reviewId = reviewContainer.getAttribute('data-review-id') ||
                            reviewContainer.querySelector('[data-review-id]')?.getAttribute('data-review-id') ||
                            `scroll_${reviews.length}`;

                        if (seenReviewIds.has(reviewId)) return;
                        seenReviewIds.add(reviewId);

                        const review = {
                            review_id: reviewId, rating: null, review_text: null,
                            published_at: null, published_at_date: null,
                            reviewer_name: null, reviewer_link: null,
                            reviewer_photo_count: null, reviewer_review_count: null,
                            is_local_guide: false, review_likes_count: 0,
                            response_from_owner_text: null, response_from_owner_ago: null
                        };

                        // Rating
                        const ratingEl = reviewContainer.querySelector('[role="img"][aria-label]');
                        if (ratingEl) {
                            const m = (ratingEl.getAttribute('aria-label') || '').match(/(\d)/);
                            if (m) review.rating = parseInt(m[1]);
                        }

                        // Text
                        for (const sel of ['span.wiI7pd', 'div.MyEned span', 'span[jsan]']) {
                            const t = reviewContainer.querySelector(sel);
                            if (t && t.textContent.trim()) { review.review_text = t.textContent.trim(); break; }
                        }

                        // Time
                        const timeEl = reviewContainer.querySelector('span.rsqaWe, span.DZSIDd span');
                        if (timeEl) review.published_at = timeEl.textContent.trim();

                        // Reviewer name
                        for (const sel of ['.d4r55.fontTitleMedium', 'button[data-href*="/maps/contrib/"]', 'a[href*="/maps/contrib/"]', '.d4r55', 'button.WEBjve']) {
                            const nameEl = reviewContainer.querySelector(sel);
                            if (nameEl) {
                                const text = nameEl.textContent.trim();
                                if (text && !text.toLowerCase().includes('more') && !text.toLowerCase().includes('photo') && text.length < 100 && text.split(' ').length <= 5) {
                                    review.reviewer_name = text; break;
                                }
                            }
                        }

                        // Profile link
                        for (const sel of ['button[data-href*="/maps/contrib/"]', 'a[href*="/maps/contrib/"]']) {
                            const linkEl = reviewContainer.querySelector(sel);
                            if (linkEl) {
                                review.reviewer_link = linkEl.getAttribute('data-href') || linkEl.getAttribute('href');
                                break;
                            }
                        }

                        // Reviewer stats
                        const statsEl = reviewContainer.querySelector('.RfnDt');
                        if (statsEl) {
                            const st = statsEl.textContent;
                            const pm = st.match(/(\d+)\s*photo/i); if (pm) review.reviewer_photo_count = parseInt(pm[1]);
                            const rm = st.match(/(\d+)\s*review/i); if (rm) review.reviewer_review_count = parseInt(rm[1]);
                            if (st.toLowerCase().includes('local guide')) review.is_local_guide = true;
                        }

                        // Owner response
                        const ownerEl = reviewContainer.querySelector('div.CDe7pd, div[class*="response"]');
                        if (ownerEl) review.response_from_owner_text = ownerEl.textContent.trim();

                        // Images
                        if (includeImages) {
                            const images = [];
                            let photoButtons = reviewContainer.querySelectorAll('button[aria-label*="Photo"][aria-label*="review" i]:not([aria-label*="Photo of"])');
                            if (photoButtons.length === 0) {
                                const parentBtns = new Set();
                                reviewContainer.querySelectorAll('button[aria-label] img[src*="googleusercontent"]').forEach(img => {
                                    const btn = img.closest('button');
                                    if (btn) parentBtns.add(btn);
                                });
                                photoButtons = Array.from(parentBtns);
                            }
                            photoButtons.forEach(button => {
                                button.querySelectorAll('img').forEach(img => {
                                    const src = img.src || img.getAttribute('data-src');
                                    if (src && src.includes('googleusercontent') && !src.includes('data:image') &&
                                        !/googleusercontent\.com\/a[-\/]/.test(src) &&
                                        !/w(36|40|54|64|72|96|128)-h(36|40|54|64|72|96|128)/.test(src) &&
                                        !src.includes('-rp-mo-') && !images.includes(src)) {
                                        images.push(src);
                                    }
                                });
                            });
                            if (images.length > 0) review.review_images = images;
                        }

                        if (review.rating || review.review_text) {
                            reviews.push(review);
                            newCount++;
                        }
                    } catch (err) {}
                });
                return newCount;
            };

            const scrollAndLoad = async (container, currentDelay) => {
                const shBefore = container.scrollHeight;
                const countBefore = document.querySelectorAll('div[data-review-id]').length;

                container.scrollBy(0, container.clientHeight * 0.8);
                container.dispatchEvent(new Event('scroll', { bubbles: true }));

                const cards = container.querySelectorAll('div[data-review-id], div.jftiEf');
                if (cards.length > 0) {
                    cards[cards.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' });
                }

                await sleep(currentDelay);

                const shAfter = container.scrollHeight;
                const countAfter = document.querySelectorAll('div[data-review-id]').length;

                return {
                    grew: shAfter > shBefore + 100 || countAfter > countBefore,
                    newDOMReviews: countAfter - countBefore,
                    scrollHeight: shAfter,
                };
            };

            // --- Main extraction loop per sort order ---

            const clickedMoreButtons = new Set();
            let totalScrolls = 0;

            for (let sortIdx = 0; sortIdx < sortPlan.length; sortIdx++) {
                const currentSort = sortPlan[sortIdx];
                const reviewsBefore = reviews.length;

                // Apply sort (skip for first if it matches default)
                if (sortIdx > 0 || (sortIdx === 0 && currentSort !== 'relevant')) {
                    const sorted = await selectSort(currentSort);
                    if (!sorted && sortIdx > 0) {
                        console.log(`[Reviews] Skipping sort "${currentSort}" — menu not available`);
                        continue;
                    }
                    await sleep(2000);
                }

                // Find/re-find scroll container after sort change
                let scrollContainer = await findContainer();
                let resetCount = 0;
                const maxResets = detectedReviewCount ? Math.ceil(detectedReviewCount / 3000) : 3; // ~1 reset per 3000 reviews
                if (!scrollContainer) {
                    console.warn(`[Reviews] Container not found for sort "${currentSort}"`);
                    if (sortIdx === 0) {
                        return { reviews, error: 'scroll_container_not_found', detectedReviewCount };
                    }
                    continue; // Try next sort
                }

                // Self-regulating scroll limit based on detected review count:
                // - Known count: scroll enough to reach the target, with buffer
                // - Unknown count: use maxScrolls, rely on stuck detection
                const remainingTarget = effectiveMax - reviews.length;
                const scrollLimit = detectedReviewCount
                    ? Math.min(maxScrolls, Math.ceil(remainingTarget / 15 * 1.5) + 20)  // ~15 new per scroll avg + buffer
                    : maxScrolls;

                console.log(`[Reviews] Sort "${currentSort}": starting scroll (limit=${scrollLimit}, reviews so far=${reviews.length})`);

                let stuckCount = 0;
                let emptyScrolls = 0;
                let sortScrolls = 0;
                let sortNewReviews = 0;
                let lastReviewCount = reviews.length;
                let lastProgressAt = 0;
                let reviewsAtCheckpoint = reviews.length;  // For yield rate tracking
                let checkpointScroll = 0;
                const delayFast = scrollDelay;
                const delaySlow = Math.max(scrollDelay * 3, 1500);

                while (sortScrolls < scrollLimit && reviews.length < effectiveMax) {
                    await clickExpandButtons(scrollContainer);
                    const newCount = extractFromDOM(scrollContainer);
                    sortNewReviews += newCount;

                    if (newCount > 0) {
                        emptyScrolls = 0;
                        lastProgressAt = sortScrolls;
                    } else {
                        emptyScrolls++;
                    }

                    const delay = emptyScrolls <= 2 ? delayFast : delaySlow;

                    // Periodic flush to disk every 100 new reviews (prevents data loss on timeout)
                    if (reviews.length - lastFlushIndex >= 100) {
                        await flushToDisk();
                    }

                    // Self-regulation: if we've reached the detected total, stop immediately
                    if (detectedReviewCount && reviews.length >= detectedReviewCount * 0.95) {
                        console.log(`[Reviews] [${currentSort}] Reached ${reviews.length}/${detectedReviewCount} (95%+), target met`);
                        break;
                    }

                    // Log progress
                    if (sortScrolls % 20 === 0) {
                        const pct = detectedReviewCount ? ` (${(reviews.length/detectedReviewCount*100).toFixed(0)}%)` : '';
                        console.log(`[Reviews] [${currentSort}] Scroll ${sortScrolls}: ${reviews.length}${pct} total (+${sortNewReviews} this sort), empty=${emptyScrolls}`);
                    }

                    // Detect "+N more photos" buttons
                    if (includeImages) {
                        for (const moreBtn of document.querySelectorAll('button.Tya61d[aria-label*="more photos"]')) {
                            const rid = moreBtn.getAttribute('data-review-id');
                            if (rid && !clickedMoreButtons.has(rid)) {
                                clickedMoreButtons.add(rid);
                            }
                        }
                    }

                    const result = await scrollAndLoad(scrollContainer, delay);

                    if (!result.grew) {
                        await sleep(3000); // Extra wait for async loading
                        const latestSH = scrollContainer.scrollHeight;
                        if (latestSH > result.scrollHeight + 100) {
                            stuckCount = 0;
                            sortScrolls++;
                            totalScrolls++;
                            continue;
                        }

                        stuckCount++;
                        const threshold = reviews.length > 500 ? 5 : 3;

                        if (stuckCount >= threshold) {
                            const scrollsSinceProgress = sortScrolls - lastProgressAt;
                            // Yield rate: how many reviews gained since last checkpoint (every 100 scrolls)?
                            const scrollsSinceCheckpoint = sortScrolls - checkpointScroll;
                            if (scrollsSinceCheckpoint >= 100) {
                                // Update checkpoint
                                reviewsAtCheckpoint = reviews.length;
                                checkpointScroll = sortScrolls;
                            }
                            const recentYield = reviews.length - reviewsAtCheckpoint;
                            const yieldRate = scrollsSinceCheckpoint > 0 ? (recentYield / scrollsSinceCheckpoint * 100).toFixed(0) : '?';
                            console.log(`[Reviews] [${currentSort}] Stuck ${stuckCount}/${threshold}, scrollsSinceProgress=${scrollsSinceProgress}, yield=${recentYield}/${scrollsSinceCheckpoint} scrolls (${yieldRate}%), reviews=${reviews.length}`);

                            // Trigger reset if: yield rate dropped below 10% (less than 10 reviews per 100 scrolls)
                            // OR no progress at all for 15 scrolls
                            const shouldReset = (scrollsSinceCheckpoint >= 50 && recentYield < 10) || scrollsSinceProgress > 15;
                            if (shouldReset) {
                                // Google's lazy loading has stalled (~3000 reviews per session).
                                // Strategy: flush current data, switch to Overview then back to Reviews
                                // to reset Google's internal loading state. seenReviewIds keeps dedup.
                                if (reviews.length < effectiveMax && resetCount < maxResets) {
                                    resetCount++;
                                    console.log(`[Reviews] [${currentSort}] Loading stalled at ${reviews.length}. Resetting panel (attempt ${resetCount}/${maxResets})...`);

                                    await flushToDisk();

                                    // Click Overview tab to leave reviews panel
                                    const overviewTab = Array.from(document.querySelectorAll('button[role="tab"]'))
                                        .find(t => t.textContent.toLowerCase().includes('overview'));
                                    if (overviewTab) {
                                        overviewTab.click();
                                        await sleep(2000);

                                        // Click Reviews tab to re-enter
                                        const reviewsTab = Array.from(document.querySelectorAll('button[role="tab"]'))
                                            .find(t => t.textContent.toLowerCase().includes('review'));
                                        if (reviewsTab) {
                                            reviewsTab.click();
                                            await sleep(3000);

                                            // Re-apply sort if not default
                                            if (currentSort !== 'relevant') {
                                                await selectSort(currentSort);
                                                await sleep(2000);
                                            }

                                            // Re-find and re-inject container
                                            const newContainer = await findContainer();
                                            if (newContainer) {
                                                scrollContainer = newContainer;

                                                // FAST-FORWARD: scroll past already-seen reviews without stuck detection.
                                                // Google reloads from the beginning after reset, so we need to
                                                // blast through duplicates until we reach uncharted territory.
                                                const reviewsBeforeFF = reviews.length;
                                                console.log(`[Reviews] [${currentSort}] Panel reset complete. Fast-forwarding past ${seenReviewIds.size} known reviews...`);
                                                for (let ff = 0; ff < 500; ff++) {
                                                    scrollContainer.scrollBy(0, scrollContainer.clientHeight);
                                                    const cards = scrollContainer.querySelectorAll('div[data-review-id], div.jftiEf');
                                                    if (cards.length > 0) cards[cards.length - 1].scrollIntoView({ block: 'end', behavior: 'instant' });
                                                    scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
                                                    await sleep(200); // Fast scroll, minimal delay
                                                    // Extract while fast-forwarding (catches new reviews mixed in)
                                                    if (ff % 10 === 0) {
                                                        extractFromDOM(scrollContainer);
                                                    }
                                                    // Stop fast-forward once we start finding new reviews consistently
                                                    if (ff > 20 && reviews.length > reviewsBeforeFF + 50) break;
                                                    // Stop if scrollHeight stopped growing (reached current end)
                                                    if (ff > 50 && scrollContainer.scrollHeight === scrollContainer.scrollHeight) break;
                                                }
                                                extractFromDOM(scrollContainer); // Final extraction
                                                const ffGained = reviews.length - reviewsBeforeFF;
                                                console.log(`[Reviews] [${currentSort}] Fast-forward complete: +${ffGained} new reviews found`);

                                                stuckCount = 0;
                                                emptyScrolls = 0;
                                                lastProgressAt = sortScrolls;
                                                reviewsAtCheckpoint = reviews.length;
                                                checkpointScroll = sortScrolls;
                                                sortScrolls++;
                                                totalScrolls++;
                                                continue;
                                            }
                                        }
                                    }
                                    console.log(`[Reviews] [${currentSort}] Panel reset failed, ending.`);
                                }

                                console.log(`[Reviews] [${currentSort}] Exhausted after ${resetCount} resets. Final: ${reviews.length} reviews from ${sortScrolls} scrolls`);
                                break;
                            }

                            // Aggressive scroll retry before declaring stuck
                            scrollContainer.scrollTop = scrollContainer.scrollHeight;
                            scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
                            const lastCard = scrollContainer.querySelector('div[data-review-id]:last-child, div.jftiEf:last-child');
                            if (lastCard) lastCard.scrollIntoView({ block: 'end', behavior: 'instant' });
                            await sleep(5000);

                            const finalCount = document.querySelectorAll('div[data-review-id]').length;
                            if (finalCount <= lastReviewCount) {
                                // No new content even after aggressive scroll — bump scrollsSinceProgress
                                sortScrolls++;
                                totalScrolls++;
                                continue;
                            }
                            stuckCount = 0;
                        }
                    } else {
                        stuckCount = 0;
                    }

                    lastReviewCount = reviews.length;
                    sortScrolls++;
                    totalScrolls++;
                }

                const sortGained = reviews.length - reviewsBefore;
                console.log(`[Reviews] Sort "${currentSort}" complete: +${sortGained} new (${reviews.length} total), ${sortScrolls} scrolls`);

                // Flush after each sort pass
                await flushToDisk();

                // Early exit if we've reached the target
                if (reviews.length >= effectiveMax) {
                    console.log(`[Reviews] Reached target (${reviews.length}/${effectiveMax}), stopping`);
                    break;
                }

                // If this sort gained very few new reviews, remaining sorts likely won't help much
                if (sortIdx > 0 && sortGained < 20) {
                    console.log(`[Reviews] Sort "${currentSort}" only gained ${sortGained} new reviews, stopping multi-sort`);
                    break;
                }
            }

            // ================================================================
            // PHASE 3: EXPAND "+N more photos" buttons
            // ================================================================
            if (includeImages && clickedMoreButtons.size > 0) {
                console.log(`[Reviews] Phase 3: Expanding ${clickedMoreButtons.size} "+N more photos" buttons...`);

                const reviewIndexMap = new Map();
                reviews.forEach((r, idx) => reviewIndexMap.set(r.review_id, idx));

                let scrollContainer = await findContainer();
                if (!scrollContainer) {
                    console.warn('[Reviews] Phase 3: Container lost, skipping photo expansion');
                } else {
                    const processedButtons = new Set();
                    scrollContainer.scrollTop = 0;
                    await sleep(1000);

                    let phase3Stuck = 0;
                    while (phase3Stuck < 3 && processedButtons.size < clickedMoreButtons.size) {
                        for (const moreBtn of document.querySelectorAll('button.Tya61d[aria-label*="more photos"]')) {
                            const rid = moreBtn.getAttribute('data-review-id');
                            if (!rid || processedButtons.has(rid) || !clickedMoreButtons.has(rid)) continue;

                            processedButtons.add(rid);
                            moreBtn.click();
                            await sleep(1500);

                            const expandedImages = [];
                            for (const btn of document.querySelectorAll(`button.Tya61d[data-review-id="${rid}"]`)) {
                                if ((btn.getAttribute('aria-label') || '').includes('more photos')) continue;
                                const bg = getComputedStyle(btn).backgroundImage;
                                const urlMatch = bg && bg.match(/url\(["']?([^"')]+)["']?\)/);
                                if (urlMatch && urlMatch[1].includes('googleusercontent') && !urlMatch[1].includes('avatar')) {
                                    expandedImages.push(urlMatch[1]);
                                }
                            }

                            if (expandedImages.length > 0) {
                                const idx = reviewIndexMap.get(rid);
                                if (idx !== undefined) reviews[idx].review_images = expandedImages;
                            }

                            const backBtn = document.querySelector('button[aria-label="Back"]');
                            if (backBtn) {
                                backBtn.click();
                                await sleep(2000);
                                // Re-find container
                                for (let r = 0; r < 5; r++) {
                                    const nc = document.querySelector('div.m6QErb.DxyBCb.kA9KIf.dS8AEf');
                                    if (nc && nc.scrollHeight > 0) { scrollContainer = nc; break; }
                                    await sleep(1000);
                                }
                            }
                        }

                        // Scroll forward
                        const sb = scrollContainer.scrollTop;
                        scrollContainer.scrollBy(0, scrollContainer.clientHeight * 0.8);
                        await sleep(scrollDelay);
                        if (scrollContainer.scrollTop === sb) phase3Stuck++;
                        else phase3Stuck = 0;
                    }
                    console.log(`[Reviews] Phase 3 complete: ${processedButtons.size}/${clickedMoreButtons.size} expanded`);
                }
            }

            // ================================================================
            // DONE
            // ================================================================
            const captureRate = detectedReviewCount ? (reviews.length / detectedReviewCount * 100).toFixed(1) : '?';
            console.log(`[Reviews] Extraction complete: ${reviews.length} reviews (${captureRate}% of ${detectedReviewCount || '?'}), ${totalScrolls} total scrolls`);

            return { reviews, error: null, detectedReviewCount };

        } catch (err) {
            console.error('[Reviews] Extraction failed:', err.message);
            return { reviews, error: err.message, detectedReviewCount };
        }
    }

    if (typeof window !== 'undefined') {
        window.extractReviewsByScrolling = extractReviewsByScrolling;
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { extractReviewsByScrolling };
    }
})();
