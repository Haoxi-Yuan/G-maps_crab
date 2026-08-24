/**
 * Review Timestamp Parser
 *
 * Parses absolute timestamps from Google Maps API responses.
 * Google Maps returns review timestamps as microsecond Unix timestamps (16 digits).
 *
 * Data structure in API response:
 * [
 *   "ChZDSUhNMG9nS0VJQ0FnSUNLOWFmMFB3EAE",  // review_id
 *   [
 *     "0x0:0x69d17c2ce13247e5",              // place reference
 *     null,
 *     1618363918805654,                      // created_at (microseconds)
 *     1633235442455410,                      // edited_at (microseconds)
 *     ...
 *   ],
 *   ...
 * ]
 */

'use strict';

/**
 * Convert microsecond timestamp to ISO date string
 * @param {number} microseconds - Unix timestamp in microseconds
 * @returns {string|null} ISO date string or null if invalid
 */
function microsecondsToISO(microseconds) {
    if (typeof microseconds !== 'number' || !Number.isFinite(microseconds)) {
        return null;
    }

    // Validate range: 2015-01-01 to 2035-01-01 in microseconds
    const MIN_VALID = 1420070400000000;  // 2015-01-01
    const MAX_VALID = 2051222400000000;  // 2035-01-01

    if (microseconds < MIN_VALID || microseconds > MAX_VALID) {
        return null;
    }

    try {
        // Convert microseconds to milliseconds
        const milliseconds = Math.floor(microseconds / 1000);
        return new Date(milliseconds).toISOString();
    } catch (e) {
        return null;
    }
}

/**
 * Check if a string looks like a Google Maps review ID
 * Review IDs are base64-encoded protobuf and come in two known formats:
 * - "Ch..." prefix (common, ~35 chars): e.g. ChZDSUhNMG9nS0VJQ0FnSUN3...
 * - "Ci..." prefix (alternate encoding, ~68 chars): e.g. Ci9DQUlRQUNvZENodHljRjlv...
 * @param {string} str - String to check
 * @returns {boolean}
 */
function isReviewId(str) {
    if (typeof str !== 'string') return false;
    // Review IDs start with "Ch" or "Ci" and are base64-encoded (20-80 chars)
    return (str.startsWith('Ch') || str.startsWith('Ci')) && str.length >= 20 && str.length <= 80;
}

/**
 * Recursively extract review timestamps from parsed API response
 * @param {any} data - Parsed JSON data
 * @param {Map} timestampMap - Map to store review_id -> timestamp info
 * @param {number} depth - Current recursion depth
 */
function extractTimestampsRecursive(data, timestampMap, depth = 0) {
    // Prevent infinite recursion
    if (depth > 20) return;

    if (!Array.isArray(data)) return;

    // Check if this array matches the review structure:
    // [review_id, [metadata_array...], ...]
    // where metadata_array[2] = created_at, metadata_array[3] = edited_at
    if (data.length >= 2 && isReviewId(data[0]) && Array.isArray(data[1])) {
        const reviewId = data[0];
        const metadata = data[1];

        // metadata[2] = created_at timestamp (microseconds)
        // metadata[3] = edited_at timestamp (microseconds)
        const createdAt = metadata[2];
        const editedAt = metadata[3];

        const createdDate = microsecondsToISO(createdAt);

        if (createdDate) {
            const editedDate = microsecondsToISO(editedAt);

            timestampMap.set(reviewId, {
                review_id: reviewId,
                created_at_us: createdAt,
                edited_at_us: editedAt,
                created_at_date: createdDate,
                edited_at_date: editedDate,
                // Keep original microseconds for precision if needed
                created_at_ms: Math.floor(createdAt / 1000),
                edited_at_ms: editedAt ? Math.floor(editedAt / 1000) : null
            });
        }
    }

    // Recursively search all array elements
    for (const item of data) {
        if (Array.isArray(item)) {
            extractTimestampsRecursive(item, timestampMap, depth + 1);
        }
    }
}

/**
 * Parse Google Maps API response text and extract review timestamps
 * @param {string} responseText - Raw response text from API
 * @returns {Map} Map of review_id -> timestamp info
 */
function parseReviewTimestamps(responseText) {
    const timestampMap = new Map();

    if (!responseText || typeof responseText !== 'string') {
        return timestampMap;
    }

    // Clean Google's anti-XSSI prefix: )]}'
    let cleanText = responseText;
    if (responseText.startsWith(")]}'")) {
        const newlineIndex = responseText.indexOf('\n');
        if (newlineIndex !== -1) {
            cleanText = responseText.substring(newlineIndex + 1);
        }
    }

    try {
        const data = JSON.parse(cleanText);
        extractTimestampsRecursive(data, timestampMap, 0);
    } catch (e) {
        // JSON parse failed - response might be protobuf or other format
        // Try to extract timestamps using regex as fallback
        extractTimestampsFromRawText(responseText, timestampMap);
    }

    return timestampMap;
}

/**
 * Fallback: Extract timestamps from raw text using regex patterns
 * This handles cases where the response isn't valid JSON
 * @param {string} text - Raw response text
 * @param {Map} timestampMap - Map to store results
 */
function extractTimestampsFromRawText(text, timestampMap) {
    // Pattern to match review_id followed by potential timestamp
    // Review IDs: "Ch..." or "Ci..." (base64 protobuf) followed by microsecond timestamps (16 digits)
    const reviewIdPattern = /"(C[hi][A-Za-z0-9_\-\/+]{20,75})"/g;
    const timestampPattern = /[,\[]\s*(1[4-9]\d{14})\s*[,\]]/g;

    // Find all review IDs
    const reviewIds = [];
    let match;
    while ((match = reviewIdPattern.exec(text)) !== null) {
        reviewIds.push({
            id: match[1],
            index: match.index
        });
    }

    // Find all potential timestamps
    const timestamps = [];
    while ((match = timestampPattern.exec(text)) !== null) {
        const ts = parseInt(match[1], 10);
        if (ts > 1420070400000000 && ts < 2051222400000000) {
            timestamps.push({
                value: ts,
                index: match.index
            });
        }
    }

    // Try to associate timestamps with nearby review IDs
    for (const review of reviewIds) {
        // Find timestamps that appear shortly after the review ID
        const nearbyTimestamps = timestamps.filter(ts =>
            ts.index > review.index && ts.index < review.index + 500
        );

        if (nearbyTimestamps.length >= 1) {
            const createdAt = nearbyTimestamps[0].value;
            const editedAt = nearbyTimestamps.length >= 2 ? nearbyTimestamps[1].value : null;

            timestampMap.set(review.id, {
                review_id: review.id,
                created_at_us: createdAt,
                edited_at_us: editedAt,
                created_at_date: microsecondsToISO(createdAt),
                edited_at_date: editedAt ? microsecondsToISO(editedAt) : null,
                created_at_ms: Math.floor(createdAt / 1000),
                edited_at_ms: editedAt ? Math.floor(editedAt / 1000) : null,
                _extracted_by: 'regex_fallback'
            });
        }
    }
}

/**
 * Check if a URL is likely to contain review data
 * @param {string} url - Request URL
 * @returns {boolean}
 */
function isReviewDataUrl(url) {
    if (!url || typeof url !== 'string') return false;

    const reviewPatterns = [
        'listugcposts',
        'listentitiesreviews',
        'getplaceposts',
        '/ugc/',
        'placeposts',
        'reviews'
    ];

    const urlLower = url.toLowerCase();
    return reviewPatterns.some(pattern => urlLower.includes(pattern));
}

/**
 * Create a response handler for Playwright page
 * @param {Map} globalTimestampMap - Shared map to accumulate timestamps
 * @param {boolean} verbose - Whether to log debug info
 * @returns {Function} Response handler function
 */
function createResponseHandler(globalTimestampMap, verbose = false) {
    return async (response) => {
        try {
            const url = response.url();

            if (!isReviewDataUrl(url)) {
                return;
            }

            // Only process successful responses
            const status = response.status();
            if (status < 200 || status >= 300) {
                return;
            }

            if (verbose) {
                console.log(`[TIMESTAMP] Intercepted review data from: ${url.substring(0, 80)}...`);
            }

            const text = await response.text();
            const parsed = parseReviewTimestamps(text);

            if (parsed.size > 0) {
                parsed.forEach((value, key) => {
                    globalTimestampMap.set(key, value);
                });

                if (verbose) {
                    console.log(`[TIMESTAMP] Extracted ${parsed.size} timestamps (total: ${globalTimestampMap.size})`);
                }
            }
        } catch (e) {
            // Silently fail - don't disrupt main flow
            if (verbose) {
                console.warn(`[TIMESTAMP] Parse error: ${e.message}`);
            }
        }
    };
}

/**
 * Apply timestamps to extracted reviews
 * @param {Array} reviews - Array of review objects from DOM extraction
 * @param {Map} timestampMap - Map of review_id -> timestamp info
 * @returns {Object} Stats about the merge operation
 */
function applyTimestampsToReviews(reviews, timestampMap) {
    if (!Array.isArray(reviews) || !timestampMap) {
        return { total: 0, matched: 0, unmatched: 0 };
    }

    let matched = 0;
    let unmatched = 0;

    for (const review of reviews) {
        if (!review.review_id) {
            unmatched++;
            continue;
        }

        const timestamp = timestampMap.get(review.review_id);

        if (timestamp) {
            review.published_at_date = timestamp.created_at_date;

            // Only add edited_at if it differs from created_at
            if (timestamp.edited_at_date &&
                timestamp.edited_at_date !== timestamp.created_at_date) {
                review.edited_at_date = timestamp.edited_at_date;
            }

            // Store raw timestamps for precision if needed
            review._timestamp_us = {
                created: timestamp.created_at_us,
                edited: timestamp.edited_at_us
            };

            matched++;
        } else {
            unmatched++;
        }
    }

    return {
        total: reviews.length,
        matched,
        unmatched,
        matchRate: reviews.length > 0 ? (matched / reviews.length * 100).toFixed(1) + '%' : '0%'
    };
}

module.exports = {
    parseReviewTimestamps,
    microsecondsToISO,
    isReviewId,
    isReviewDataUrl,
    createResponseHandler,
    applyTimestampsToReviews
};
