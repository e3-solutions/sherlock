import { createRoot } from "react-dom/client";

import "@fontsource/geist-sans/latin-400.css";
import "@fontsource/geist-sans/latin-500.css";
import "@fontsource/geist-sans/latin-600.css";
import "@fontsource/geist-sans/latin-700.css";

import App from "./App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);
