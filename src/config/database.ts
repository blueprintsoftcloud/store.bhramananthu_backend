import "dotenv/config";
import mongoose from "mongoose";
import logger from "../utils/logger";

export const connectDB = async (): Promise<void> => {
  try {
    // MONGO_URL only — no longer falls back to DATABASE_URL, which used to
    // make it ambiguous which var was actually authoritative for the Mongo
    // connection whenever both happened to be set.
    const url = process.env.MONGO_URL;

    if (!url) {
      logger.error("❌ MONGO_URL is missing in .env");
      throw new Error("MONGO_URL environment variable is required");
    }

    await mongoose.connect(url);
    logger.info(`✅ MongoDB connected to DB: ${mongoose.connection.name}`);
  } catch (err) {
    logger.error("❌ Database connection failed", err);
    process.exit(1);
  }
};

export const disconnectDB = async (): Promise<void> => {
  await mongoose.disconnect();
};



