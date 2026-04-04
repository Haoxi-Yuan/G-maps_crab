/**
 * Review Image Downloader
 * Downloads review images from URLs and saves them locally
 *
 * Usage:
 * const downloader = new ReviewImageDownloader(outputBaseDir);
 * await downloader.downloadReviewImages(placeId, reviews);
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class ReviewImageDownloader {
  constructor(baseDir = '/Volumes/Data/time_scraper/output/images') {
    this.baseDir = baseDir;
    this.downloadStats = {
      total: 0,
      success: 0,
      failed: 0
    };
  }

  /**
   * Download a single image from URL
   * @param {string} imageUrl - URL of the image
   * @param {string} savePath - Local path to save the image
   * @returns {Promise<boolean>} - Success status
   */
  /**
   * Download a single image, following redirects and with retry support.
   * @param {string} imageUrl - URL of the image
   * @param {string} savePath - Local path to save the image
   * @param {number} [maxRedirects=3] - Maximum redirects to follow
   * @returns {Promise<boolean>} - Success status
   */
  async downloadImage(imageUrl, savePath, maxRedirects = 3) {
    return new Promise((resolve) => {
      try {
        const dir = path.dirname(savePath);
        fs.mkdirSync(dir, { recursive: true });

        const protocol = imageUrl.startsWith('https') ? https : http;

        const request = protocol.get(imageUrl, (response) => {
          // Handle redirects (301, 302, 303, 307, 308)
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            response.resume(); // Consume response to free up memory
            if (maxRedirects <= 0) {
              this.downloadStats.failed++;
              resolve(false);
              return;
            }
            this.downloadImage(response.headers.location, savePath, maxRedirects - 1)
              .then(resolve);
            return;
          }

          if (response.statusCode !== 200) {
            response.resume();
            this.downloadStats.failed++;
            resolve(false);
            return;
          }

          // Validate content type
          const contentType = response.headers['content-type'] || '';
          if (contentType && !contentType.includes('image') && !contentType.includes('octet-stream')) {
            response.resume();
            this.downloadStats.failed++;
            resolve(false);
            return;
          }

          const file = fs.createWriteStream(savePath);

          file.on('error', () => {
            file.destroy();
            fs.unlink(savePath, () => {});
            this.downloadStats.failed++;
            resolve(false);
          });

          response.pipe(file);
          file.on('finish', () => {
            file.close();
            this.downloadStats.success++;
            resolve(true);
          });
        });

        request.on('error', (err) => {
          fs.unlink(savePath, () => {});
          console.warn(`[IMAGE-DOWNLOAD] Error downloading ${imageUrl}: ${err.message}`);
          this.downloadStats.failed++;
          resolve(false);
        });

        // Adaptive timeout: 15s base, generous for larger images
        request.setTimeout(15000, () => {
          request.destroy();
          fs.unlink(savePath, () => {});
          console.warn(`[IMAGE-DOWNLOAD] Timeout downloading ${imageUrl}`);
          this.downloadStats.failed++;
          resolve(false);
        });

      } catch (err) {
        console.warn(`[IMAGE-DOWNLOAD] Exception: ${err.message}`);
        this.downloadStats.failed++;
        resolve(false);
      }
    });
  }

  /**
   * Download with retry support
   * @param {string} imageUrl - URL of the image
   * @param {string} savePath - Local path to save the image
   * @param {number} [maxRetries=2] - Maximum retry attempts
   * @returns {Promise<boolean>} - Success status
   */
  async downloadWithRetry(imageUrl, savePath, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const success = await this.downloadImage(imageUrl, savePath);
      if (success) return true;
      if (attempt < maxRetries) {
        // Brief backoff before retry
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    return false;
  }

  /**
   * Sanitize filename to remove invalid characters
   * @param {string} filename - Original filename
   * @returns {string} - Sanitized filename
   */
  sanitizeFilename(filename) {
    return filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  /**
   * Download images for a single review
   * @param {string} placeId - Place ID
   * @param {string} reviewId - Review ID
   * @param {Array<string>} imageUrls - Array of image URLs
   * @returns {Promise<Array<string>>} - Array of local image paths
   */
  async downloadReviewImages(placeId, reviewId, imageUrls) {
    if (!imageUrls || imageUrls.length === 0) {
      return [];
    }

    const sanitizedPlaceId = this.sanitizeFilename(placeId);
    const sanitizedReviewId = this.sanitizeFilename(reviewId);
    const reviewDir = path.join(this.baseDir, sanitizedPlaceId, sanitizedReviewId);

    const localPaths = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const imageUrl = imageUrls[i];
      this.downloadStats.total++;

      // Determine image extension from URL
      let ext = '.jpg';
      try {
        const urlObj = new URL(imageUrl);
        const urlPath = urlObj.pathname;
        const urlExt = path.extname(urlPath).toLowerCase();
        if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(urlExt)) {
          ext = urlExt;
        }
      } catch (err) {
        // Use default .jpg extension
      }

      const filename = `image_${i + 1}${ext}`;
      const savePath = path.join(reviewDir, filename);

      const success = await this.downloadImage(imageUrl, savePath);

      if (success) {
        // Store relative path for portability
        const relativePath = path.relative(this.baseDir, savePath);
        localPaths.push(relativePath);
      }
    }

    return localPaths;
  }

  /**
   * Download images for all reviews of a place
   * @param {string} placeId - Place ID
   * @param {Array<Object>} reviews - Array of review objects
   * @param {boolean} verbose - Enable verbose logging
   * @returns {Promise<void>}
   */
  async downloadAllReviewImages(placeId, reviews, verbose = false) {
    if (!reviews || reviews.length === 0) {
      return;
    }

    let reviewsWithImages = 0;
    let totalImages = 0;

    for (const review of reviews) {
      if (review.review_images && review.review_images.length > 0) {
        reviewsWithImages++;
        totalImages += review.review_images.length;

        const localPaths = await this.downloadReviewImages(
          placeId,
          review.review_id,
          review.review_images
        );

        // Add local paths to review object
        if (localPaths.length > 0) {
          review.local_image_paths = localPaths;
        }
      }
    }

    if (verbose && reviewsWithImages > 0) {
      console.log(`[IMAGE-DOWNLOAD] Downloaded images for ${reviewsWithImages} reviews (${totalImages} total images)`);
    }
  }

  /**
   * Get download statistics
   * @returns {Object} - Download stats
   */
  getStats() {
    return { ...this.downloadStats };
  }

  /**
   * Reset download statistics
   */
  resetStats() {
    this.downloadStats = {
      total: 0,
      success: 0,
      failed: 0
    };
  }
}

module.exports = ReviewImageDownloader;
