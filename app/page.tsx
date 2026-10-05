import { redirect } from "next/navigation";

export default function Home() {
  // Refresh the entry URL with public-script fixes so reopened tabs load them.
  redirect("/asset-tracker/index.html?v=60");
}
