// Load environment variables from a .env file into process.env
require("dotenv").config();

// Class to handle Telegram messaging
class TelegramNotifier {
  constructor(token, channel) {
    this.token = token;
    this.channel = channel;
  }

  async sendMessage(message) {
    try {
      // Construct the Telegram API endpoint for sending a message
      const request = await fetch(
        `https://api.telegram.org/bot${this.token}/sendMessage?chat_id=${this.channel}&text=${message}`,
        {
          method: "GET",
          redirect: "follow",
        }
      );

      // Parse the JSON response from the Telegram API
      const response = await request.json();

      // Return the response object
      return response;
    } catch (error) {
      // Handle errors by logging them to the console
      console.error("Error sending Telegram message:", error);
      return null;
    }
  }
}

// Export the TelegramNotifier class
module.exports = TelegramNotifier;
