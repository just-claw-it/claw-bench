import { NavLink } from "react-router-dom";

const links = [
  { to: "/", label: "Overview", icon: "◉" },
  { to: "/catalog", label: "Catalog", icon: "◎" },
  { to: "/runs", label: "Runs", icon: "☰" },
  { to: "/compare", label: "Compare", icon: "⇔" },
  { to: "/import", label: "Import", icon: "↑" },
];

interface Props {
  dark: boolean;
  onToggleDark: () => void;
}

export default function Sidebar({ dark, onToggleDark }: Props) {
  return (
    <aside className="w-56 shrink-0 bg-slate-900 text-slate-300 flex flex-col">
      <div className="px-5 py-6">
        <h1 className="text-lg font-bold text-white tracking-tight">
          claw-bench
        </h1>
        <p className="text-xs text-slate-500 mt-0.5">Dashboard</p>
      </div>

      <nav className="flex-1 px-3 space-y-1">
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? "bg-slate-800 text-white"
                  : "hover:bg-slate-800/50 hover:text-white"
              }`
            }
          >
            <span className="text-base">{link.icon}</span>
            {link.label}
          </NavLink>
        ))}
      </nav>

      <div className="px-5 py-4 border-t border-slate-800">
        <button
          onClick={onToggleDark}
          className="flex items-center gap-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
        >
          <span>{dark ? "☀" : "☾"}</span>
          {dark ? "Light mode" : "Dark mode"}
        </button>
      </div>
    </aside>
  );
}
