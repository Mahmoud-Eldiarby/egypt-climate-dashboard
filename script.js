
const stripeColors = [
  '#dfeaf2', '#b0d8eb', '#8bc5d7', '#9ec0d9', '#b8bbd8', '#d7b0c9',
  '#e3c0a7', '#f0c28f', '#efc060', '#f0ad4d', '#ef7d59', '#cf4b5d',
  '#7d5a74', '#6a8ea9', '#6e9a9b', '#9ab299', '#c5c07e', '#e7c463',
  '#efbf7d', '#eb9b6a', '#d95c52', '#b03f46', '#7b3d5c', '#5d586f', '#79a5b7'
];

const stripes = document.getElementById('stripes');
if (stripes) {
  const values = ['2000','2001','2002','2003','2004','2005','2006','2007','2008','2009','2010','2011','2012','2013','2014','2015','2016','2017','2018','2019','2020','2021','2022','2023','2024'];
  values.forEach((year, index) => {
    const span = document.createElement('span');
    span.title = `${year}: ${index < 7 ? 'cooler' : 'hotter'} year`;
    span.style.background = stripeColors[index % stripeColors.length];
    stripes.appendChild(span);
  });
}

const chartCtx = document.getElementById('annualChart');
if (chartCtx && typeof Chart !== 'undefined') {
  const data = {
    labels: ['2000','2001','2002','2003','2004','2005','2006','2007','2008','2009','2010','2011','2012','2013','2014','2015','2016','2017','2018','2019','2020','2021','2022','2023','2024'],
    datasets: [
      {
        label: 'Annual mean',
        data: [21.88,22.47,22.58,22.40,22.33,22.22,22.11,22.39,22.73,22.52,23.76,21.90,22.52,22.49,22.80,22.64,22.87,22.32,23.29,22.68,22.61,23.05,22.43,23.49,23.45],
        borderColor: '#ff9c68',
        backgroundColor: 'rgba(255,156,104,0.18)',
        pointBackgroundColor: '#ffd1af',
        pointRadius: 2,
        borderWidth: 2.5,
        fill: false,
        tension: 0.25
      },
      {
        label: 'Linear trend',
        data: [21.8,21.95,22.10,22.25,22.38,22.53,22.67,22.82,22.96,23.08,23.20,23.34,23.48,23.62,23.74,23.88,24.02,24.16,24.28,24.42,24.55,24.70,24.84,24.98,25.14],
        borderColor: '#f6d8cd',
        borderDash: [7, 8],
        pointRadius: 0,
        borderWidth: 1.5,
        fill: false
      }
    ]
  };

  new Chart(chartCtx, {
    type: 'line',
    data,
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { color: '#e8b5a7', maxTicksLimit: 7 },
          grid: { display: false },
          border: { color: 'rgba(255,255,255,0.06)' }
        },
        y: {
          ticks: { color: '#e8b5a7' },
          grid: { color: 'rgba(255,255,255,0.06)' },
          border: { color: 'rgba(255,255,255,0.06)' },
          title: { display: true, text: '°C', color: '#e8b5a7' }
        }
      },
      plugins: {
        legend: { labels: { color: '#ffd1af' } },
        tooltip: { backgroundColor: '#2d0b13', borderColor: '#ff9966', borderWidth: 1 }
      }
    }
  });
}
