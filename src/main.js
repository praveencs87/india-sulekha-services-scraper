import { armKillSwitch, disarmKillSwitch } from './utils/timeoutManager.js';
import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { 
        keyword = 'packers and movers', 
        location = 'Chennai', 
        maxLeads = 100,
        proxyConfiguration 
    } = input || {};

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { 
        useApifyProxy: true,
        apifyProxyGroups: ['RESIDENTIAL'],
        apifyProxyCountry: 'IN'
    });

    log.info(`Searching Sulekha India for "${keyword}" in "${location}"`);
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency: 1, // Keep concurrency low for Indian directories
        navigationTimeoutSecs: 90,
        browserPoolOptions: {
            useFingerprints: true,
        },
        async requestHandler({ page, request, log, enqueueLinks }) {
            log.info(`Parsing directory page: ${request.url}`);
            
            await page.waitForSelector('.list-item, .pro-list-item, .sd-details-item, .listing-card', { timeout: 30000 }).catch(() => log.warning('Timeout waiting for DOM.'));

            const title = await page.title();
            if (title.includes('Just a moment') || title.includes('Access Denied')) {
                throw new Error('Blocked by WAF. Retrying with residential proxy...');
            }
            
            // Scroll down a bit to trigger lazy loading
            await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
            await page.waitForTimeout(2000);

            const items = await page.$$('.list-item, .pro-list-item, .sd-details-item, .listing-card');
            
            for (const item of items) {
                if (extractedCount >= maxLeads) break;

                const nameElement = await item.$('.provider-name, h3, h2, .biz-name');
                if (!nameElement) continue;
                const providerName = (await nameElement.innerText()).trim();

                const addressElement = await item.$('.locality, .address, .location, .biz-address');
                const address = addressElement ? (await addressElement.innerText()).trim().replace(/\s+/g, ' ') : '';

                // Phones - Try to grab from href if obfuscated, else innerText
                const phoneElement = await item.$('a[href^="tel:"], .phone, .contact-number, .call-btn');
                let phone = '';
                if (phoneElement) {
                    const href = await phoneElement.getAttribute('href');
                    if (href && href.startsWith('tel:')) {
                        phone = href.replace('tel:', '').trim();
                    } else {
                        phone = (await phoneElement.innerText()).trim();
                    }
                }

                // Ratings
                const ratingElement = await item.$('.rating, .score, .rating-badge');
                const rating = ratingElement ? (await ratingElement.innerText()).trim() : '';
                
                // Reviews count
                const reviewElement = await item.$('.review-count, .reviews, .total-ratings');
                const reviews = reviewElement ? (await reviewElement.innerText()).trim() : '';
                
                // URL
                const urlElement = await item.$('a.provider-name, h3 a, h2 a, a.biz-name');
                const listingUrl = urlElement ? await urlElement.getAttribute('href') : '';
                const fullListingUrl = listingUrl && !listingUrl.startsWith('http') ? new URL(listingUrl, 'https://www.sulekha.com').toString() : listingUrl;

                if (providerName && providerName.length > 1) {
                    const record = {
                        providerName,
                        category: keyword,
                        address,
                        phone,
                        rating: `${rating} ${reviews}`.trim(),
                        listingUrl: fullListingUrl,
                        scrapedAt: new Date().toISOString()
                    };

                    await Actor.pushData(record);
                    await Actor.charge({ eventName: 'lead-extracted', count: 1 });
                    extractedCount++;
                    log.info(`✅ Extracted: ${providerName} (${extractedCount}/${maxLeads})`);
                }
            }

            // Pagination - Sulekha typically uses a next button or load more
            if (extractedCount < maxLeads) {
                const hasNextPage = await page.$('a.next, .pagination .next, a:has-text("Next")');
                if (hasNextPage) {
                    const nextUrl = await hasNextPage.getAttribute('href');
                    if (nextUrl) {
                        const absoluteUrl = new URL(nextUrl, 'https://www.sulekha.com').toString();
                        log.info(`Enqueuing next page: ${absoluteUrl}`);
                        await enqueueLinks({
                            urls: [absoluteUrl],
                        });
                    }
                } else {
                    // Fallback to page query parameter increment
                    const currentUrl = new URL(request.url);
                    let pageNum = 1;
                    
                    // Look for page parameter in URL path or search params
                    const pathParts = currentUrl.pathname.split('/');
                    const lastPart = pathParts[pathParts.length - 1];
                    if (lastPart.match(/^p\d+$/)) {
                        pageNum = parseInt(lastPart.replace('p', ''));
                        pathParts[pathParts.length - 1] = `p${pageNum + 1}`;
                        currentUrl.pathname = pathParts.join('/');
                    } else if (currentUrl.searchParams.has('page')) {
                        pageNum = parseInt(currentUrl.searchParams.get('page'));
                        currentUrl.searchParams.set('page', (pageNum + 1).toString());
                    } else {
                        // Standard append depending on site structure
                        if (currentUrl.pathname.endsWith('/')) {
                             currentUrl.pathname = currentUrl.pathname + 'p2';
                        } else {
                             currentUrl.pathname = currentUrl.pathname + '/p2';
                        }
                    }
                    
                    if(pageNum < 10) { 
                        log.info(`Attempting synthetic pagination to: ${currentUrl.toString()}`);
                        await enqueueLinks({
                            urls: [currentUrl.toString()],
                        });
                    }
                }
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Failed request: ${request.url}`);
        }
    });

    const formatLocation = location.toLowerCase().replace(/\s+/g, '-');
    const formatKeyword = keyword.toLowerCase().replace(/\s+/g, '-');
    const startUrl = `https://www.sulekha.com/${formatKeyword}/${formatLocation}`;
    
    await crawler.addRequests([{
        url: startUrl
    }]);

    armKillSwitch(crawler);
    await crawler.run();
    disarmKillSwitch();

    log.info(`🎉 Done! Extracted ${extractedCount} India Sulekha leads.`);

} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
