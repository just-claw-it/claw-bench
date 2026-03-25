import { Routes, Route } from "react-router-dom";
import { useEffect, useState } from "react";
import Sidebar from "./components/Sidebar";
import Overview from "./pages/Overview";
import Catalog from "./pages/Catalog";
import SkillAnalysis from "./pages/SkillAnalysis";
import RunsExplorer from "./pages/RunsExplorer";
import SkillDetail from "./pages/SkillDetail";
import Compare from "./pages/Compare";
import Import from "./pages/Import";

export default function App() {
  const [dark, setDark] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("claw-bench-dark") === "true" ||
      (!localStorage.getItem("claw-bench-dark") && window.matchMedia("(prefers-color-scheme: dark)").matches);
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("claw-bench-dark", String(dark));
  }, [dark]);

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar dark={dark} onToggleDark={() => setDark((d) => !d)} />
      <main className="flex-1 overflow-y-auto p-6 lg:p-8">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/catalog/:slug" element={<SkillAnalysis />} />
          <Route path="/runs" element={<RunsExplorer />} />
          <Route path="/skills/:name" element={<SkillDetail />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/import" element={<Import />} />
        </Routes>
      </main>
    </div>
  );
}
