import { Request, Response } from "express";
import { Address } from "../models/mongoose";
import { calculateShippingWithConfig } from "../services/shipping.service";
import { getWarehouseCoords, getShippingConfigFromDB } from "../utils/warehouseSettings";
import logger from "../utils/logger";
import NodeGeocoder from "node-geocoder";

const geocoder = NodeGeocoder({ provider: "openstreetmap" });

/**
 * Cleans the street address by removing duplicated city, state, zipCode, and country from the end.
 */
const cleanStreetAddress = (
  fullAddress: string,
  city: string,
  state: string,
  zipCode: string,
  country: string
): string => {
  let clean = fullAddress || "";
  
  const termsToRemove = [
    country,
    zipCode,
    state,
    city
  ].filter(Boolean);

  for (const term of termsToRemove) {
    const escapedTerm = term.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`[,\\s]*${escapedTerm}\\b`, 'gi');
    clean = clean.replace(regex, '');
  }

  // Trim any trailing commas, periods, spaces
  clean = clean.replace(/[,.\s]+$/, '').trim();
  
  return clean || fullAddress;
};

// POST /api/address/save-geo  (authenticated)
export const saveLocationAndGetShipping = async (req: Request, res: Response) => {
  try {
    const { latitude, longitude } = req.body;
    const userId = req.user!.id;

    if (latitude === undefined || longitude === undefined || latitude === null || longitude === null) {
      return res.status(400).json({ message: "latitude and longitude are required" });
    }

    let geoResponse;
    try {
      geoResponse = await geocoder.reverse({ lat: latitude, lon: longitude });
      if (!geoResponse.length) {
        return res.status(400).json({ message: "No delivery address found for these coordinates (ocean or water area). Please select a location on land in India." });
      }
      const data = geoResponse[0];
      const countryName = (data.country || "").trim();
      const countryCode = (data.countryCode || "").trim().toUpperCase();

      if (
        (countryCode && countryCode !== "IN") ||
        (countryName && countryName.toLowerCase() !== "india") ||
        (!countryName && !countryCode) ||
        (!data.state && !data.city && !data.zipcode)
      ) {
        return res.status(400).json({
          message: `Delivery is only available within India.${countryName && countryName.toLowerCase() !== "india" ? ` Selected location is in ${countryName}.` : " Please click on land in India."}`,
        });
      }
    } catch (err: any) {
      if (err.message && err.message.includes("Delivery is only available")) {
        return res.status(400).json({ message: err.message });
      }
      return res.status(400).json({ message: "No delivery address found for these coordinates (ocean/water area). Please select a location on land in India." });
    }
    const data = geoResponse[0];

    const [warehouse, config] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
    const shippingResult = await calculateShippingWithConfig(
      latitude, longitude, "India", data.state ?? "", data.city ?? "", data.zipcode ?? "", config, warehouse.lat, warehouse.lng,
    );
    const shippingCharge = shippingResult.shippingCharge;
    const distanceKm = shippingResult.distanceKm;

    const existingDefault = await Address.findOne({ userId, isDefault: true });
    const cityVal = data.city ?? "";
    const stateVal = data.state ?? "";
    const zipCodeVal = data.zipcode ?? "";
    const countryVal = "India";
    const addressData = {
      userId,
      fullAddress: cleanStreetAddress(data.formattedAddress ?? "", cityVal, stateVal, zipCodeVal, countryVal),
      city: cityVal,
      state: stateVal,
      country: countryVal,
      zipCode: zipCodeVal,
      latitude,
      longitude,
      isDefault: true,
    };
    const toggles = {
      calculateShippingForCOD: config.calculateShippingForCOD !== false,
      calculateShippingForOnline: config.calculateShippingForOnline !== false,
      calculateShippingForQR: config.calculateShippingForQR !== false,
    };

    const address = existingDefault
      ? await Address.findByIdAndUpdate(existingDefault.id, addressData, { new: true })
      : await Address.create(addressData);

    res.status(200).json({ address, distance: distanceKm.toFixed(2) + " KM", shippingCharge, ...toggles });
  } catch (err: any) {
    logger.error("saveLocationAndGetShipping error", err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/address/save-manual  (authenticated)
export const saveManualAddress = async (req: Request, res: Response) => {
  try {
    const { fullAddress, city, state, zipCode, country = "India", latitude, longitude, locality, secondaryPhone } = req.body;
    const userId = req.user!.id;

    if (!fullAddress || !city || !zipCode) {
      return res.status(400).json({ message: "fullAddress, city, and zipCode are required" });
    }

    const existingDefault = await Address.findOne({ userId, isDefault: true });
    const lat = typeof latitude === "number" ? latitude : (existingDefault?.latitude ?? null);
    const lng = typeof longitude === "number" ? longitude : (existingDefault?.longitude ?? null);

    const [warehouse, config] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);
    const shippingCharge = (await calculateShippingWithConfig(lat ?? 0, lng ?? 0, country, state ?? "", city ?? "", zipCode, config, warehouse.lat, warehouse.lng)).shippingCharge;

    const toggles = {
      calculateShippingForCOD: config.calculateShippingForCOD !== false,
      calculateShippingForOnline: config.calculateShippingForOnline !== false,
      calculateShippingForQR: config.calculateShippingForQR !== false,
    };

    const addressData = {
      userId,
      fullAddress,
      locality: locality ? String(locality).trim() : existingDefault?.locality,
      city,
      state: state ?? "",
      country,
      zipCode,
      secondaryPhone: secondaryPhone ? String(secondaryPhone).trim() : existingDefault?.secondaryPhone,
      latitude: lat,
      longitude: lng,
      isDefault: true,
    };
    const address = existingDefault
      ? await Address.findByIdAndUpdate(existingDefault.id, addressData, { new: true })
      : await Address.create(addressData);

    res.status(200).json({ address, shippingCharge, ...toggles });
  } catch (err: any) {
    logger.error("saveManualAddress error", err);
    res.status(500).json({ error: err.message });
  }
};

// GET /api/address/default  (authenticated)
export const getDefaultAddress = async (req: Request, res: Response) => {
  try {
    const userId = req.user!.id;
    const address = await Address.findOne({ userId, isDefault: true });
    res.json({ address: address ?? null });
  } catch (err: any) {
    logger.error("getDefaultAddress error", err);
    res.status(500).json({ error: err.message });
  }
};

// POST /api/address/preview-shipping  (authenticated)
// Returns shipping estimate WITHOUT saving to DB — used by the delivery preview modal.
export const previewShipping = async (req: Request, res: Response) => {
  try {
    const { latitude, longitude, manual, state: manualState, city: manualCity } = req.body;

    const [warehouse, config] = await Promise.all([getWarehouseCoords(), getShippingConfigFromDB()]);

    const toggles = {
      calculateShippingForCOD: config.calculateShippingForCOD !== false,
      calculateShippingForOnline: config.calculateShippingForOnline !== false,
      calculateShippingForQR: config.calculateShippingForQR !== false,
    };

    // Manual mode — no GPS, use provided state/city/zipCode for rate lookup
    if (manual) {
      const result = await calculateShippingWithConfig(0, 0, "India", manualState ?? "", manualCity ?? "", req.body.zipCode ?? "", config, warehouse.lat, warehouse.lng);
      return res.json({ ...result, ...toggles, free: false });
    }

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ message: "latitude and longitude required for GPS preview" });
    }

    let state = "";
    let country = "India";
    let fullAddress = "";
    let city = "";
    let zipCode = "";
    try {
      const geo = await geocoder.reverse({ lat: latitude, lon: longitude });
      if (!geo.length) {
        return res.status(400).json({ message: "No delivery address found for these coordinates (ocean/water area). Please select a location on land in India." });
      }
      const data = geo[0];
      const countryName = (data.country || "").trim();
      const countryCode = (data.countryCode || "").trim().toUpperCase();

      if (
        (countryCode && countryCode !== "IN") ||
        (countryName && countryName.toLowerCase() !== "india") ||
        (!countryName && !countryCode) ||
        (!data.state && !data.city && !data.zipcode)
      ) {
        return res.status(400).json({
          message: `Delivery is only available within India.${countryName && countryName.toLowerCase() !== "india" ? ` Selected location is in ${countryName}.` : " Please click on land in India."}`,
        });
      }

      state = data.state ?? "";
      country = "India";
      city = data.city ?? "";
      zipCode = data.zipcode ?? "";
      fullAddress = cleanStreetAddress(data.formattedAddress ?? "", city, state, zipCode, country);
    } catch (err: any) {
      if (err.message && err.message.includes("Delivery is only available")) {
        return res.status(400).json({ message: err.message });
      }
      return res.status(400).json({ message: "Could not resolve a valid delivery address for this location. Please click on land in India." });
    }

    if (!state && typeof req.body.state === "string") state = req.body.state.trim();
    if (!city && typeof req.body.city === "string") city = req.body.city.trim();
    if (!zipCode && typeof req.body.zipCode === "string") zipCode = req.body.zipCode.trim();

    const result = await calculateShippingWithConfig(latitude, longitude, country, state, city, zipCode, config, warehouse.lat, warehouse.lng);
    return res.json({ ...result, ...toggles, address: fullAddress, city, state, country, zipCode, lat: latitude, lng: longitude, free: false });
  } catch (err: any) {
    logger.error("previewShipping error", err);
    res.status(500).json({ error: err.message });
  }
};
