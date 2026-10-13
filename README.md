# tampermonkey-scripts

## Scripts

### [job-board.js](./job-board/job-board.js)

Dismisses (LinkedIn/Indeed) job postings from specific companies on page load, and hides them from the results. This seems to be necessary in the post-AI job market. Indeed advertise thousands of "jobs" that are actually spam to the typical job-seeker not looking for data-labeling/annotating part-time 1099 "jobs". Indeed's "dislike" button doesn't permanently hide the disliked job posting, and neither site applies a dislike to identical listings by the same company. LinkedIn job board also tends to host positions from other boards/companies that are not really reputable, so they can be filtered out via this script.

The blacklist is shared across both sites and can be viewed, edited, or reset from the Tampermonkey menu.
