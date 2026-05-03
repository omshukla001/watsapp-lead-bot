// Phone helpers shared between baileysService and chatController.
// Lives in /utils to avoid circular import (baileys → controller → baileys).

// E.164: + followed by 10-13 digits. Real WhatsApp accounts are 11-13
// (India 12, US 11, UK 12). Garbage like Date.now() / random IDs from
// dashboard seed scripts is 14+ digits and gets rejected.
function isValidWhatsAppPhone(phone) {
  if (!phone || typeof phone !== 'string') return false;
  return /^\+[1-9]\d{9,12}$/.test(phone);
}

module.exports = { isValidWhatsAppPhone };
