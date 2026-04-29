import pool from "../db/index.js";

export async function deleteProfileHandler(req, res) {
  const { id } = req.params;

  try {
    const { rowCount } = await pool.query(
      "DELETE FROM db_profiles WHERE id = $1",
      [id],
    );

    if (rowCount === 0) {
      return res
        .status(404)
        .json({ status: "error", message: "Profile not found" });
    }

    return res.status(204).send();
  } catch {
    return res
      .status(500)
      .json({ status: "error", message: "Internal server error" });
  }
}
