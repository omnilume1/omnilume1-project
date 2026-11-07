/* global chrome */
// Opens OmniLume's share page with a link; the person picks a room there and
// the room opens with the link ready to play or queue.
const OMNILUME = 'https://omnilume.vercel.app';

const isWebLink = (value) => typeof value === 'string' && /^https?:\/\//i.test(value);
const share = (url) => {
  if (isWebLink(url)) chrome.tabs.create({ url: `${OMNILUME}/share?url=${encodeURIComponent(url)}` });
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'omnilume-share', title: 'Send to an OmniLume room', contexts: ['link', 'page', 'video'] });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  // A playing video's own source is often a blob: address; the page link works instead.
  const video = isWebLink(info.srcUrl) ? info.srcUrl : '';
  share(info.linkUrl || video || info.pageUrl || tab?.url);
});

// The toolbar button sends the page you are on.
chrome.action.onClicked.addListener((tab) => share(tab.url));

// The "Send to OmniLume" button that content.js adds on YouTube and Twitch.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message?.type === 'omnilume-share') share(message.url);
});
