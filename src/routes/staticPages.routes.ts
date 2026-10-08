import { Router } from "express";
import { getStaticPages, updateStaticPage } from "../controllers/staticPages.controller";
import { authMiddleware } from "../middleware/auth.middleware";
import { adminOrStaff } from "../middleware/staffPermission.middleware";

const router = Router();

// Public: fetch static pages content
router.get("/", getStaticPages);

// Admin/Staff with BANNER_EDIT permission: update static page content
router.put("/:page", authMiddleware, adminOrStaff("BANNER_EDIT"), updateStaticPage);

export default router;
