-- Phone and email from the user's address book (vCard / Google Contacts CSV), used only for the
-- user's own WhatsApp / SMS / email links. Private: never sent to Claude or Tavily.
alter table contacts add column if not exists phone text;   -- E.164, e.g. +12065550142
alter table contacts add column if not exists email text;
