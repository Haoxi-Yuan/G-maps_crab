import React from 'react';

export const Card = ({ children, className = "" }) => (
  <div className={`bg-zinc-900/50 border border-zinc-800 p-6 backdrop-blur-sm ${className}`}>
    {children}
  </div>
);

export const SectionTitle = ({ icon: Icon, title, description }) => (
  <div className="mb-6 flex items-start space-x-3">
    {Icon && <Icon className="w-5 h-5 text-zinc-400 mt-1" />}
    <div>
      <h3 className="text-zinc-100 font-medium tracking-wide uppercase text-sm">{title}</h3>
      {description && <p className="text-zinc-500 text-xs mt-1">{description}</p>}
    </div>
  </div>
);

export const Label = ({ children, required }) => (
  <label className="block text-xs font-medium text-zinc-400 mb-2 uppercase tracking-wider">
    {children} {required && <span className="text-zinc-600">*</span>}
  </label>
);

export const Input = ({ type = "text", placeholder, value, defaultValue, disabled, className = "", onChange }) => (
  <input
    type={type}
    disabled={disabled}
    value={value}
    defaultValue={defaultValue}
    onChange={onChange}
    placeholder={placeholder}
    className={`w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm px-4 py-3 focus:outline-none focus:border-zinc-500 transition-colors placeholder-zinc-700 ${disabled ? 'opacity-40 cursor-not-allowed' : ''} ${className}`}
  />
);

export const Select = ({ options, value, defaultValue, onChange }) => (
  <div className="relative">
    <select
      value={value}
      defaultValue={defaultValue}
      onChange={onChange}
      className="w-full bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm px-4 py-3 appearance-none focus:outline-none focus:border-zinc-500 transition-colors"
    >
      {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
    <div className="absolute right-4 top-3.5 pointer-events-none text-zinc-600">▼</div>
  </div>
);

export const Toggle = ({ label, checked, onChange, disabled }) => (
  <div className={`flex items-center justify-between py-2 ${disabled ? 'opacity-40' : ''}`}>
    <span className="text-zinc-400 text-sm">{label}</span>
    <button
      onClick={() => !disabled && onChange(!checked)}
      className={`w-10 h-5 rounded-full relative transition-colors ${checked ? 'bg-zinc-100' : 'bg-zinc-800'}`}
    >
      <div className={`absolute top-1 w-3 h-3 rounded-full bg-zinc-950 transition-transform ${checked ? 'left-6' : 'left-1'}`} />
    </button>
  </div>
);

export const Button = ({ children, variant = "primary", icon: Icon, className = "", onClick, disabled = false }) => {
  const baseStyle = "flex items-center justify-center px-6 py-3 text-xs font-bold uppercase tracking-widest transition-all duration-300";
  const variants = {
    primary: "bg-zinc-100 text-zinc-950 hover:bg-white hover:shadow-[0_0_15px_rgba(255,255,255,0.1)]",
    secondary: "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700",
    outline: "bg-transparent border border-zinc-600 text-zinc-400 hover:border-zinc-300 hover:text-zinc-200",
    danger: "bg-zinc-900 border border-red-900/30 text-red-500 hover:bg-red-900/10"
  };

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${baseStyle} ${variants[variant]} ${disabled ? 'opacity-40 cursor-not-allowed pointer-events-none' : ''} ${className}`}
    >
      {Icon && <Icon className="w-4 h-4 mr-2" />}
      {children}
    </button>
  );
};
