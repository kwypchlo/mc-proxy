import ky from "ky";

try {
  const response = await ky.get("http://localhost:3000/stats", { timeout: 5000 });

  if (response.status === 200) {
    console.log("Healthcheck passed");

    process.exit(0);
  } else {
    throw new Error(`/stats returned ${response.status} ${response.statusText}`);
  }
} catch (error) {
  console.log(`Healthcheck failed with ${String(error)}`);

  process.exit(1);
}
